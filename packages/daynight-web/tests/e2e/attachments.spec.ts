import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { attachmentDownloadUrl, attachmentPageUrl, attachmentPreviewUrl } from '../../src/api/client';
import { createAcceptanceCli } from '../../scripts/acceptance/installed-cli.mts';
import { createProject, createTask, expect, test, type Task } from './fixtures';
import { expectCenteredTaskDetail } from './detail-dialog';
import { longConfirmationPath } from '../mockups/attachment-paths';
import { hasPaintedPdfMarker, readPdfPixels, type PdfPixels } from './pdf-pixels';

const exact = (value: string): RegExp => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const asset = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fileButton = async (region: Locator, path: string): Promise<Locator> => {
  let branch = region.getByRole('navigation', { name: /^(附件文件|Attachment files)$/ }).locator(':scope > ul');
  const parts = path.split('/');
  for (const name of parts.slice(0, -1)) {
    const summary = branch.locator(':scope > li > details > summary').filter({ hasText: exact(`▱ ${name}`) });
    await expect(summary).toHaveCount(1);
    const directory = summary.locator('..');
    if (await directory.getAttribute('open') === null) await summary.click();
    branch = directory.locator(':scope > ul');
  }
  const name = branch.locator(':scope > li > .attachment-file-row > .attachment-file > .attachment-file-name').filter({ hasText: exact(parts.at(-1)!) });
  await expect(name).toHaveCount(1);
  return name.locator('..');
};
const selectFile = async (region: Locator, path: string): Promise<void> => {
  await (await fileButton(region, path)).click();
  await expect(region.getByRole('heading', { name: path, exact: true })).toBeVisible();
};
const fileActions = async (region: Locator, path: string): Promise<Locator> =>
  (await fileButton(region, path)).locator('..').locator('.attachment-actions-trigger');
const confirmDeletion = async (page: Page, region: Locator, path: string): Promise<Locator> => {
  await (await fileActions(region, path)).click();
  await page.getByRole('menuitem', { name: /^(删除|Delete)$/ }).click();
  const confirmation = page.locator('.attachment-delete-dialog');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(path);
  return confirmation;
};

const pathEdges = async (confirmation: Locator): Promise<{ prefix: boolean; tail: boolean }> =>
  await confirmation.locator('.attachment-delete-path').evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text)) throw new Error('The confirmation path has no readable text node.');
    const body = element.closest('.attachment-delete-body');
    if (body === null) throw new Error('The confirmation path has no scrolling body.');
    const bounds = body.getBoundingClientRect();
    const visible = (start: number, end: number) => {
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      const rect = range.getBoundingClientRect();
      return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    };
    return { prefix: visible(0, Math.min(24, text.length)), tail: visible(Math.max(0, text.length - 24), text.length) };
  });

const settleScroll = async (owner: Locator): Promise<void> => {
  // Native scrolling continues while task-polling timers are paused in the page.
  const started = performance.now();
  let quietSince = started;
  let previous = await owner.evaluate((element) => element.scrollTop);
  while (true) {
    await delay(16);
    const current = await owner.evaluate((element) => element.scrollTop);
    const now = performance.now();
    if (current !== previous) { previous = current; quietSince = now; }
    if (now - quietSince >= 100) return;
    if (now - started >= 3_000) throw new Error('The preview did not reach a stable scroll position.');
  }
};

const paintedPdf = async (page: Page, frame: Locator, info: TestInfo, source: Buffer, url: string, prefix = 'task-attachments'): Promise<PdfPixels> => {
  let painted: Buffer | undefined;
  let metrics: PdfPixels | undefined;
  await expect.poll(async () => {
    const png = await frame.screenshot({ animations: 'disabled' });
    const current = await page.evaluate(readPdfPixels, png.toString('base64'));
    if (!hasPaintedPdfMarker(current)) return false;
    painted = png;
    metrics = current;
    return true;
  }, { message: 'The native PDF viewer paints the solid fixture rectangle', timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
  if (painted === undefined || metrics === undefined) throw new Error('PDF paint evidence was not captured.');
  const screenshot = info.outputPath(`${prefix}-pdf.png`);
  const receipt = info.outputPath(`${prefix}-pdf.json`);
  await writeFile(screenshot, painted);
  await writeFile(receipt, `${JSON.stringify({ schemaVersion: 1, path: 'reports/brief.pdf', url, sha256: createHash('sha256').update(source).digest('hex'), markerRgb: [17, 203, 149], tolerance: 4, ...metrics }, null, 2)}\n`);
  await info.attach(`${prefix}-painted-pdf`, { path: screenshot, contentType: 'image/png' });
  await info.attach(`${prefix}-painted-pdf-pixels`, { path: receipt, contentType: 'application/json' });
  return metrics;
};

test('task-attachments', { annotation: { type: 'scenario', description: 'task-attachments' } }, async ({ page, api: request, allowAttachmentWrites }, info) => {
  const project = await createProject(request, { name: `Attachments ${randomUUID()}` });
  const task = await createTask(request, project.id, { title: 'CLI 与 Web 共享同一任务附件', description: '验证文件内容、预览和单文件操作。' });
  const baseURL = info.project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('Attachment acceptance requires the actual service base URL.');
  const acceptanceDirectory = process.env.DAYNIGHT_ACCEPTANCE_DIRECTORY;
  if (acceptanceDirectory === undefined) throw new Error('Attachment acceptance requires its target receipt.');
  const target = JSON.parse(await readFile(join(acceptanceDirectory, 'target.json'), 'utf8')) as { target?: unknown; caseSensitiveStorage?: unknown };
  if (typeof target.caseSensitiveStorage !== 'boolean' || !['native', 'container'].includes(String(target.target))
    || (!target.caseSensitiveStorage && (target.target !== 'native' || process.platform !== 'darwin'))) {
    throw new Error('Attachment acceptance has invalid filesystem case-sensitivity coverage.');
  }
  info.annotations.push({ type: 'storage-case-sensitivity', description: target.caseSensitiveStorage ? 'case-sensitive' : 'native-filesystem-only' });
  const encodedPath = `${target.caseSensitiveStorage ? 'Docs' : 'references'}/设计 #?%.json`;
  const directory = info.outputPath('attachment-files');
  await mkdir(directory, { recursive: true });
  const cli = await createAcceptanceCli(baseURL, info.outputPath('installed-cli'));
  try {
    const command = async (args: readonly string[]): Promise<string> => {
      const result = await cli.run(args);
      expect(result.exitCode, `Installed CLI succeeds: ${args.join(' ')}`).toBe(0);
      expect(result.stderr, 'Successful installed CLI commands keep stderr empty').toBe('');
      return result.stdout;
    };
    const args = (operation: string, values: readonly string[] = []): string[] => ['task', 'attachment', operation, task.id, ...values, '--project', project.id];
    const put = async (path: string, bytes: Buffer, index: string): Promise<void> => {
      const source = join(directory, `${index}.data`);
      await writeFile(source, bytes);
      await command(args('put', [source, '--path', path]));
    };
    const binary = Buffer.from([0, 255, 1, 128, 13, 10, 200, 0, 254, 42]);
    const pdf = await readFile(asset('../mockups/files/brief.pdf'));
    const wideColumns = Array.from({ length: 16 }, (_, index) => `Column ${index + 1}`);
    const wideTable = `| ${wideColumns.join(' | ')} |\n| ${wideColumns.map(() => '---').join(' | ')} |\n| ${wideColumns.map(() => 'Long table content').join(' | ')} |`;
    const longCode = `const attachmentContent = '${'unbroken-source-'.repeat(80)}';`;
    const longPath = `long/${'long-file-name-'.repeat(12)}.txt`;
    const seeds = [
      { path: 'docs/design.md', bytes: Buffer.from(`# 附件设计\n\n| 文件 | 状态 |\n| --- | --- |\n| Web | 已连接 |\n\n${wideTable}\n\n\`\`\`js\n${longCode}\n\`\`\`\n\n![项目流程](../images/workflow.svg)\n\n[同名文本](../notes/one/same.txt)\n\n<script>window.attachmentLeak = true</script>\n`) },
      { path: 'notes/one/same.txt', bytes: Buffer.from('First nested text\nSecond line\n') },
      { path: 'notes/two/same.txt', bytes: Buffer.from('Second same-name text\n') },
      { path: 'empty.txt', bytes: Buffer.alloc(0) },
      { path: encodedPath, bytes: Buffer.from('{\n  \"sameFile\": true\n}\n') },
      { path: 'binary/bytes.bin', bytes: binary },
      { path: 'images/workflow.svg', bytes: await readFile(asset('../mockups/files/images/workflow.svg')) },
      { path: 'reports/brief.pdf', bytes: pdf },
      { path: 'site/index.html', bytes: await readFile(asset('./attachment-files/site/index.html')) },
      { path: 'site/style.css', bytes: await readFile(asset('../mockups/files/site/style.css')) },
      { path: 'site/app.js', bytes: await readFile(asset('./attachment-files/site/app.js')) },
      { path: longPath, bytes: Buffer.from('Long path attachment content\n'.repeat(200)) },
      { path: longConfirmationPath, bytes: Buffer.from('Portable long-path confirmation fixture\n') },
      { path: 'long/reading.md', bytes: await readFile(asset('../mockups/files/docs/tall.md')) },
      { path: 'long/reading.txt', bytes: await readFile(asset('../mockups/files/data/tall.txt')) },
      { path: 'long/reading.svg', bytes: await readFile(asset('../mockups/files/images/tall.svg')) },
      { path: 'long/reading.html', bytes: await readFile(asset('../mockups/files/site/tall.html')) },
      { path: 'long/reading.pdf', bytes: await readFile(asset('../mockups/files/tall.pdf')) },
      { path: 'site/data.json', bytes: await readFile(asset('./attachment-files/site/data.json')) },
    ];
    for (const [index, seed] of seeds.entries()) await put(seed.path, seed.bytes, `seed-${index}`);
    const listed = JSON.parse(await command(args('list', ['--json']))) as { path: string; sizeBytes: number }[];
    expect(listed.map(({ path }) => path)).toEqual(seeds.map(({ path }) => path).toSorted());
    expect(listed.find(({ path }) => path === 'empty.txt')?.sizeBytes).toBe(0);
    expect(await cli.read(args('read', ['binary/bytes.bin']))).toEqual(binary);
    expect(await cli.read(args('read', ['empty.txt']))).toEqual(Buffer.alloc(0));
    expect(await cli.read(args('read', ['reports/brief.pdf']))).toEqual(pdf);

    const uploadedPath = 'uploads/Web #? 空.bin';
    const origin = new URL(baseURL).origin;
    allowAttachmentWrites([
      { origin, method: 'PUT', projectId: project.id, taskId: task.id, path: uploadedPath, count: 2 },
      { origin, method: 'DELETE', projectId: project.id, taskId: task.id, path: uploadedPath, count: 1 },
      { origin, method: 'DELETE', projectId: project.id, taskId: task.id, path: 'notes/one/same.txt', count: 2 },
      { origin, method: 'DELETE', projectId: project.id, taskId: task.id, path: 'notes/two/same.txt', count: 1 },
    ]);
    let graphReads = 0;
    let detailReads = 0;
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === `/api/v1/projects/${project.id}/task-sync`) graphReads += 1;
      if (path === `/api/v1/projects/${project.id}/tasks/${task.id}`) detailReads += 1;
    });
    // Isolate attachment-triggered reads from the independently tested task polling timer.
    const clockTime = new Date('2030-01-01T00:00:00Z');
    await page.clock.install({ time: clockTime });
    await page.clock.pauseAt(clockTime);
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    const trigger = page.locator(`#standalone-task-${task.id}`);
    await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
    const originalOverflow = await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }));
    await trigger.click();
    const dialog = page.locator('.task-detail-dialog');
    await expect(dialog).toHaveAccessibleName(task.title);
    const attachments = dialog.locator('.task-attachments');
    await expect(dialog.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
    await dialog.getByRole('tab', { name: '附件', exact: true }).click();
    const expectReleased = async (): Promise<void> => {
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }))).toEqual(originalOverflow);
    };
    await expect(attachments.getByRole('heading', { name: `附件 · ${seeds.length}`, exact: true })).toBeVisible();
    const uploadDisclosure = attachments.locator('.attachment-upload-disclosure');
    const uploadSummary = uploadDisclosure.locator('summary');
    await expect(uploadDisclosure).not.toHaveAttribute('open', '');
    await expect(attachments.getByLabel('选择一个文件')).toBeHidden();
    await uploadSummary.focus();
    await page.keyboard.press('Enter');
    await expect(uploadDisclosure).toHaveAttribute('open', '');
    await expect(attachments.getByLabel('选择一个文件')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(uploadDisclosure).not.toHaveAttribute('open', '');

    const embeddedAddress = page.url();
    const embeddedHistory = await page.evaluate(() => history.length);
    await selectFile(attachments, 'notes/one/same.txt');
    await selectFile(attachments, 'docs/design.md');
    expect(page.url()).toBe(embeddedAddress);
    expect(await page.evaluate(() => history.length)).toBe(embeddedHistory);
    await expect(attachments.getByRole('table').first()).toContainText('Web已连接');
    const markdownImage = attachments.getByRole('img', { name: '项目流程' });
    await expect(markdownImage).toHaveAttribute('src', attachmentPreviewUrl(project.id, task.id, 'images/workflow.svg'));
    await expect.poll(() => markdownImage.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(attachments.getByRole('link', { name: '同名文本' })).toHaveAttribute('href', attachmentPreviewUrl(project.id, task.id, 'notes/one/same.txt'));
    await expect(attachments.locator('script')).toHaveCount(0);
    await expect(attachments.getByText('<script>window.attachmentLeak = true</script>')).toBeVisible();
    expect(await page.evaluate(() => Object.hasOwn(window, 'attachmentLeak'))).toBe(false);
    await expect(attachments.locator('.attachment-markdown pre')).toHaveText(longCode);
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expectCenteredTaskDetail(page, dialog);
      expect(await dialog.locator('.task-detail-body').evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
      const split = await attachments.locator('.attachment-split').boundingBox();
      const left = await attachments.locator('.attachment-sidebar').boundingBox();
      const right = await attachments.locator('.attachment-preview-pane').boundingBox();
      expect(split && left && right && left.x + left.width <= right.x + 1 && left.y === right.y && right.height === left.height).toBeTruthy();
      expect(await attachments.locator('.attachment-markdown pre').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      if (width === 320) expect(await attachments.locator('.attachment-markdown .markdown-table').last().evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 800 });
    const openerViewport = page.viewportSize();
    if (openerViewport === null) throw new Error('Attachment acceptance requires an explicit opener viewport.');
    const readerUrl = attachmentPageUrl(project.id, task.id, 'docs/design.md');
    const newTabLink = attachments.getByRole('link', { name: '在新标签页打开', exact: true });
    await expect(newTabLink).toHaveAttribute('href', readerUrl);
    await expect(newTabLink).toHaveAttribute('target', '_blank');
    await expect(newTabLink).toHaveAttribute('rel', 'noopener noreferrer');
    const [reader] = await Promise.all([page.waitForEvent('popup'), newTabLink.click()]);
    const readerErrors: string[] = [];
    const readerWrites: string[] = [];
    reader.on('pageerror', (error) => readerErrors.push(error.name));
    reader.on('request', (request) => {
      if (!['GET', 'HEAD'].includes(request.method())) readerWrites.push(`${request.method()} ${request.url()}`);
    });
    await expect(reader).toHaveURL(new URL(readerUrl, origin).href);
    expect(await reader.evaluate(() => window.opener === null)).toBe(true);
    await expect(reader.locator('.task-detail-title')).toHaveText(task.title);
    await expect(reader.getByRole('tab', { name: '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(reader.getByRole('table').first()).toContainText('Web已连接');
    await expect(reader.getByRole('navigation', { name: '工作空间导航' })).toHaveCount(0);
    await expect(reader.getByRole('dialog')).toHaveCount(0);
    await expect(reader.getByRole('img', { name: '项目流程' })).toHaveJSProperty('complete', true);
    await expect.poll(() => reader.getByRole('img', { name: '项目流程' }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(reader.locator('.attachment-markdown pre')).toHaveText(longCode);
    await expect(attachments.getByRole('heading', { name: 'docs/design.md', exact: true })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
    const readerAttachments = reader.locator('.task-attachments');
    await expect(readerAttachments.getByRole('navigation', { name: '附件文件', exact: true })).toBeVisible();
    const readerSidebar = await readerAttachments.locator('.attachment-sidebar').elementHandle();
    if (readerSidebar === null) throw new Error('The standalone attachment sidebar is absent.');
    const readerUpload = readerAttachments.locator('.attachment-upload-disclosure');
    await readerUpload.locator('summary').click();
    await readerAttachments.getByRole('textbox', { name: '目标相对路径' }).fill('drafts/reader.txt');
    await readerUpload.locator('summary').click();
    const readerLongDirectory = readerAttachments.locator('summary').filter({ hasText: exact('▱ long') }).locator('..');
    await readerLongDirectory.locator('summary').first().click();
    await expect(readerLongDirectory).not.toHaveAttribute('open', '');
    await selectFile(readerAttachments, 'notes/one/same.txt');
    await expect(reader).toHaveURL(new URL(attachmentPageUrl(project.id, task.id, 'notes/one/same.txt'), origin).href);
    await expect(await fileButton(readerAttachments, 'notes/one/same.txt')).toHaveAttribute('aria-pressed', 'true');
    await expect(readerAttachments.locator('pre')).toHaveText('First nested text\nSecond line\n');
    await selectFile(readerAttachments, 'notes/two/same.txt');
    await expect(reader).toHaveURL(new URL(attachmentPageUrl(project.id, task.id, 'notes/two/same.txt'), origin).href);
    await reader.goBack();
    await expect(readerAttachments.locator('pre')).toHaveText('First nested text\nSecond line\n');
    await reader.goForward();
    await expect(readerAttachments.locator('pre')).toHaveText('Second same-name text\n');
    await expect(readerLongDirectory).not.toHaveAttribute('open', '');
    await expect(readerUpload).not.toHaveAttribute('open', '');
    await expect(readerAttachments.getByLabel('目标相对路径')).toHaveValue('drafts/reader.txt');
    expect(await readerSidebar.evaluate((element) => element.isConnected)).toBe(true);
    await reader.reload();
    await expect(readerAttachments.locator('pre')).toHaveText('Second same-name text\n');
    const standaloneUploadPath = 'standalone/reader-upload.txt';
    const standaloneUploadUrl = new URL(attachmentDownloadUrl(project.id, task.id, standaloneUploadPath), origin).href;
    await readerUpload.locator('summary').click();
    await readerAttachments.getByLabel('选择一个文件').setInputFiles({ name: 'reader.txt', mimeType: 'text/plain', buffer: Buffer.from('Standalone shared upload\n') });
    await readerAttachments.getByRole('textbox', { name: '目标相对路径' }).fill(standaloneUploadPath);
    await readerAttachments.getByRole('button', { name: '上传文件', exact: true }).click();
    await expect(readerAttachments.locator('pre')).toHaveText('Standalone shared upload\n');
    await expect(reader).toHaveURL(new URL(attachmentPageUrl(project.id, task.id, standaloneUploadPath), origin).href);
    expect(await cli.read(args('read', [standaloneUploadPath]))).toEqual(Buffer.from('Standalone shared upload\n'));
    const standaloneDeletion = await confirmDeletion(reader, readerAttachments, standaloneUploadPath);
    await standaloneDeletion.getByRole('button', { name: '删除附件', exact: true }).click();
    await expect(standaloneDeletion).toBeHidden();
    await expect(readerAttachments.locator('.attachment-file-name').filter({ hasText: exact('reader-upload.txt') })).toHaveCount(0);
    expect(readerWrites).toEqual([`PUT ${standaloneUploadUrl}`, `DELETE ${standaloneUploadUrl}`]);
    await selectFile(readerAttachments, 'docs/design.md');
    for (const method of ['get', 'head'] as const) {
      const response = await request[method](readerUrl);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('text/html');
      if (method === 'head') expect(await response.body()).toHaveLength(0);
      else expect(await response.text()).toContain('<div id="root"></div>');
    }
    expect((await request.post(readerUrl)).status()).toBe(405);
    expect((await request.get(`/projects/${project.id}/tasks/${task.id}/unknown/file.txt`)).status()).toBe(404);
    const readerScrollEvidence: unknown[] = [];
    for (const viewport of [{ width: 1440, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) {
      await reader.setViewportSize(viewport);
      const standalonePanes = await readerAttachments.locator('.attachment-sidebar,.attachment-preview-pane').evaluateAll((elements) => elements.map((element) => {
        const bounds = element.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, top: bounds.top, height: bounds.height };
      }));
      expect(standalonePanes[0]!.right).toBeLessThanOrEqual(standalonePanes[1]!.left + 1);
      expect(standalonePanes[0]!.top).toBe(standalonePanes[1]!.top);
      expect(standalonePanes[1]!.height).toBeGreaterThan(80);
      expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const extension of ['md', 'txt', 'svg', 'html', 'pdf']) {
        await reader.goto(attachmentPageUrl(project.id, task.id, `long/reading.${extension}`));
        await expect(reader.getByRole('heading', { name: `long/reading.${extension}`, exact: true })).toBeVisible();
        await expect(reader.getByRole('link', { name: '下载', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(reader.getByRole('combobox', { name: '语言 / Language', exact: true })).toBeInViewport({ ratio: 1 });
        const body = reader.locator('.attachment-preview-body');
        if (extension === 'svg') await expect.poll(() => reader.getByRole('img').evaluate((image) => (image as HTMLImageElement).naturalHeight)).toBeGreaterThan(0);
        const native = extension === 'html' || extension === 'pdf';
        if (native) {
          const frame = reader.locator('iframe');
          await expect(frame).toBeInViewport({ ratio: 1 });
          const frameBounds = await frame.boundingBox();
          const bodyBounds = await body.boundingBox();
          expect(frameBounds!.height).toBeCloseTo(bodyBounds!.height, 0);
          if (extension === 'html') {
            await expect(frame.contentFrame().locator('#counter')).toBeVisible();
            await frame.contentFrame().locator('#counter').click();
            await expect(frame.contentFrame().locator('#counter')).toHaveText('1');
            await reader.keyboard.press('Escape');
            await expect(frame).toBeVisible();
            expect(await frame.contentFrame().locator('html').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
          }
        } else await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        const outer = await body.evaluate((element) => {
          const chain = [];
          for (let node: Element | null = element; node !== null; node = node.parentElement) chain.push({ className: node.className, height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY });
          return chain;
        });
        expect(outer.slice(1).filter((entry) => entry.scrollHeight > entry.height + 1)).toEqual([]);
        if (native) expect(outer[0]!.scrollHeight).toBeLessThanOrEqual(outer[0]!.height + 1);
        readerScrollEvidence.push({ viewport, extension, outer });
      }
      await reader.goto(attachmentPageUrl(project.id, task.id, longPath));
      await expect(reader.getByRole('heading', { name: longPath, exact: true })).toHaveAttribute('title', longPath);
      await expect(reader.getByRole('link', { name: '下载', exact: true })).toBeInViewport({ ratio: 1 });
    }
    await reader.goto(attachmentPageUrl(project.id, task.id, 'site/index.html'));
    const readerHtml = reader.getByTitle('HTML 预览：site/index.html');
    await expect(readerHtml.contentFrame().locator('#data')).toHaveText('Attachment same-data journey · in_progress');
    await expect.poll(() => readerHtml.contentFrame().getByRole('img', { name: 'Project workflow' }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await readerHtml.contentFrame().locator('body').evaluate((body) => getComputedStyle(body).backgroundColor)).toBe('rgb(246, 247, 252)');
    await readerHtml.contentFrame().getByRole('button', { name: '完成一个任务' }).click();
    await expect(readerHtml.contentFrame().locator('#result')).toHaveText('已完成 3 个任务');
    await reader.goto(attachmentPageUrl(project.id, task.id, 'notes/one/same.txt'));
    await expect(reader.locator('pre')).toHaveText('First nested text\nSecond line\n');
    await reader.goto(attachmentPageUrl(project.id, task.id, encodedPath));
    await expect(reader.locator('pre')).toHaveText('{\n  \"sameFile\": true\n}\n');
    await reader.reload();
    await expect(reader.locator('pre')).toHaveText('{\n  \"sameFile\": true\n}\n');
    await reader.goto(attachmentPageUrl(project.id, task.id, 'binary/bytes.bin'));
    await expect(reader.getByText('此文件暂不支持预览，请下载后打开。')).toBeVisible();
    await expect(reader.getByRole('link', { name: '下载' })).toHaveAttribute('href', attachmentDownloadUrl(project.id, task.id, 'binary/bytes.bin'));
    const [binaryDownload] = await Promise.all([reader.waitForEvent('download'), reader.getByRole('link', { name: '下载' }).click()]);
    const downloadedPath = await binaryDownload.path();
    if (downloadedPath === null) throw new Error('The standalone unsupported-file download was not saved.');
    expect(await readFile(downloadedPath)).toEqual(binary);
    // The lower-page PDF marker needs a tall paint viewport; compact sizing and
    // native scroll ownership are verified independently in the viewport matrix.
    await reader.setViewportSize(openerViewport);
    await reader.goto(attachmentPageUrl(project.id, task.id, 'reports/brief.pdf'));
    await paintedPdf(reader, reader.getByTitle('PDF 预览：reports/brief.pdf'), info, pdf, new URL(attachmentPreviewUrl(project.id, task.id, 'reports/brief.pdf'), origin).href, 'standalone-attachments');
    await reader.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
    await reader.reload();
    await expect(reader.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
    await reader.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
    // Chromium tabs share native window bounds; return ownership to the opener before closing the resized reader.
    await reader.setViewportSize(openerViewport);
    await reader.close();
    expect(readerErrors).toEqual([]);
    await page.bringToFront();
    await info.attach('standalone-attachment-scroll-owners', { body: Buffer.from(JSON.stringify(readerScrollEvidence, null, 2)), contentType: 'application/json' });
    const scrollEvidence: unknown[] = [];
    for (const viewport of [{ width: 1440, height: 800 }, { width: 768, height: 800 }, { width: 600, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const extension of ['md', 'txt', 'svg', 'html', 'pdf']) {
        await selectFile(attachments, `long/reading.${extension}`);
        const body = attachments.locator('.attachment-preview-body');
        const native = extension === 'html' || extension === 'pdf';
        if (extension === 'svg') await expect.poll(() => attachments.getByRole('img').evaluate((image) => (image as HTMLImageElement).naturalHeight)).toBeGreaterThan(0);
        await expectCenteredTaskDetail(page, dialog);
        const panes = await attachments.locator('.attachment-sidebar,.attachment-preview-pane').evaluateAll((elements) => elements.map((element) => {
          const bounds = element.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, top: bounds.top, height: bounds.height };
        }));
        expect(panes[0]!.right).toBeLessThanOrEqual(panes[1]!.left + 1);
        expect(panes[0]!.top).toBe(panes[1]!.top);
        expect(panes[1]!.height).toBeGreaterThan(80);
        for (const action of ['下载', '在新标签页打开']) await expect(attachments.getByRole('link', { name: action, exact: true })).toBeInViewport({ ratio: 1 });
        const outer = await body.evaluate((element) => {
          const chain = [];
          for (let node: Element | null = element; node !== null && !node.classList.contains('task-detail-backdrop'); node = node.parentElement) chain.push({ className: node.className, height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY });
          return chain;
        });
        expect(outer.slice(1).filter((entry) => entry.scrollHeight > entry.height + 1)).toEqual([]);
        if (!native) {
          expect(outer[0]!.scrollHeight).toBeGreaterThan(outer[0]!.height);
          const bounds = await body.boundingBox();
          if (bounds === null) throw new Error('The preview scroll owner has no bounds.');
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, 180);
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          await settleScroll(body);
          await body.evaluate((element) => { element.scrollTop = 0; });
          await body.focus();
          await page.keyboard.press('PageDown');
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          await settleScroll(body);
          const position = await body.evaluate((element) => element.scrollTop);
          const left = attachments.locator('.attachment-sidebar');
          await left.evaluate((element) => { element.scrollTop = element.scrollHeight; });
          expect(await body.evaluate((element) => element.scrollTop)).toBe(position);
          await left.evaluate((element) => { element.scrollTop = 0; });
        } else {
          const frame = attachments.locator('iframe');
          await expect(frame).toBeInViewport({ ratio: 1 });
          const frameBounds = await frame.boundingBox();
          const bodyBounds = await body.boundingBox();
          expect(frameBounds!.height).toBeCloseTo(bodyBounds!.height, 0);
          expect(outer[0]!.scrollHeight).toBeLessThanOrEqual(outer[0]!.height + 1);
          if (extension === 'html') {
            const content = frame.contentFrame();
            await expect(content.locator('#counter')).toBeVisible();
            expect(await content.locator('html').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            await page.mouse.move(frameBounds!.x + frameBounds!.width / 2, frameBounds!.y + frameBounds!.height / 2);
            await page.mouse.wheel(0, 180);
            await expect.poll(() => content.locator('html').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
            await settleScroll(content.locator('html'));
            await content.locator('html').evaluate((element) => { element.scrollTop = 0; });
            await content.locator('#counter').focus();
            await page.keyboard.press('PageDown');
            await expect.poll(() => content.locator('html').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
            await settleScroll(content.locator('html'));
          }
        }
        scrollEvidence.push({ viewport, extension, outer, panes });
      }
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await selectFile(attachments, 'long/reading.md');
    const changeDetailLanguage = async (locale: string): Promise<void> => {
      const confirmation = await confirmDeletion(page, attachments, 'docs/design.md');
      await confirmation.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      await confirmation.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
    };
    await expect(dialog.locator('.task-detail-header').getByRole('combobox')).toHaveCount(0);
    for (const locale of ['zh-CN', 'en']) {
      await changeDetailLanguage(locale);
      const shortScreenshot = info.outputPath(`task-attachments-short-${locale}.png`);
      await page.screenshot({ path: shortScreenshot, fullPage: false });
      await info.attach(`task-attachments-short-${locale}`, { path: shortScreenshot, contentType: 'image/png' });
    }
    await changeDetailLanguage('zh-CN');
    await page.setViewportSize({ width: 320, height: 800 });
    await selectFile(attachments, longPath);
    await expect(attachments.getByRole('heading', { name: longPath, exact: true })).toHaveAttribute('title', longPath);
    for (const action of ['下载', '在新标签页打开']) await expect(attachments.getByRole('link', { name: action, exact: true })).toBeInViewport({ ratio: 1 });
    await info.attach('attachment-scroll-owners', { body: Buffer.from(JSON.stringify(scrollEvidence, null, 2)), contentType: 'application/json' });
    await page.setViewportSize({ width: 320, height: 800 });
    await selectFile(attachments, 'docs/design.md');
    const narrowScreenshot = info.outputPath('task-attachments-narrow.png');
    await page.screenshot({ path: narrowScreenshot, fullPage: false });
    await info.attach('task-attachments-narrow', { path: narrowScreenshot, contentType: 'image/png' });
    await page.setViewportSize({ width: 1600, height: 1100 });
    await selectFile(attachments, 'notes/one/same.txt');
    await expect(attachments.locator('pre')).toHaveText('First nested text\nSecond line\n');
    const refreshedText = Buffer.from('CLI replacement appears after attachment refresh\n');
    await put('notes/one/same.txt', refreshedText, 'external-replacement');
    await attachments.getByRole('button', { name: '刷新附件', exact: true }).click();
    await expect(attachments.locator('pre')).toHaveText(refreshedText.toString('utf8'));
    await selectFile(attachments, 'notes/two/same.txt');
    await expect(attachments.locator('pre')).toHaveText('Second same-name text\n');
    await selectFile(attachments, 'empty.txt');
    await expect(attachments.locator('pre')).toHaveText('');
    await selectFile(attachments, 'images/workflow.svg');
    await expect.poll(() => attachments.getByRole('img').evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);

    await selectFile(attachments, 'site/index.html');
    const html = attachments.getByTitle('HTML 预览：site/index.html');
    await expect(html).toHaveAttribute('src', attachmentPreviewUrl(project.id, task.id, 'site/index.html'));
    await expect(html).not.toHaveAttribute('sandbox');
    const content = html.contentFrame();
    await expect(content.locator('#data')).toHaveText('Attachment same-data journey · in_progress');
    expect(await content.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor)).toBe('rgb(246, 247, 252)');
    await expect.poll(() => content.getByRole('img', { name: 'Project workflow' }).evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await content.getByRole('button', { name: '完成一个任务' }).click();
    await expect(content.locator('#result')).toHaveText('已完成 3 个任务');
    const innerButton = content.getByRole('button', { name: '完成一个任务' });
    const frameHandle = await html.elementHandle();
    const input = attachments.getByLabel('选择一个文件');
    const inputHandle = await input.elementHandle();
    await uploadSummary.click();
    await input.setInputFiles({ name: 'unsent.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsent draft') });
    await attachments.getByRole('textbox', { name: '目标相对路径' }).fill('drafts/unsent.txt');
    await uploadSummary.click();
    await expect(input).toBeHidden();
    const notes = attachments.locator('summary').filter({ hasText: exact('▱ notes') }).locator('..');
    await notes.locator('summary').first().click();
    await expect(notes).not.toHaveAttribute('open', '');
    await innerButton.focus();
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await expect(dialog.getByRole('tab', { name: '概览', exact: true })).toBeFocused();
    await expect(dialog.locator('.task-detail-panel-attachments')).toHaveAttribute('inert', '');
    await expect(html).toBeHidden();
    await dialog.getByRole('tab', { name: '附件', exact: true }).click();
    expect(await frameHandle!.evaluate((element) => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    expect(await inputHandle!.evaluate((element) => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
    await expect(content.locator('#result')).toHaveText('已完成 3 个任务');
    await expect(uploadDisclosure).not.toHaveAttribute('open', '');
    await uploadSummary.click();
    await expect(attachments.getByRole('textbox', { name: '目标相对路径' })).toHaveValue('drafts/unsent.txt');
    expect(await input.evaluate((element) => (element as HTMLInputElement).files?.[0]?.name)).toBe('unsent.txt');
    await expect(notes).not.toHaveAttribute('open', '');
    await frameHandle!.dispose();
    await inputHandle!.dispose();

    await innerButton.focus();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.task-detail-title')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.task-detail-title-row button[aria-haspopup="menu"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '删除任务', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.task-detail-fullscreen-toggle')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.task-detail-popout')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '关闭任务详情', exact: true })).toBeFocused();
    await innerButton.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(attachments.getByRole('link', { name: '在新标签页打开', exact: true })).toBeFocused();
    await innerButton.focus();
    await page.keyboard.press('Escape');
    await expectReleased();
    const freshReader = await page.context().newPage();
    await freshReader.goto(readerUrl);
    await expect(freshReader.getByRole('heading', { name: '附件设计', exact: true })).toBeVisible();
    await freshReader.reload();
    await expect(freshReader.getByRole('table').first()).toContainText('Web已连接');
    await freshReader.close();
    expect(graphReads).toBe(1);
    expect(detailReads).toBe(1);
    const secondOpen = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/tasks/${task.id}`);
    await trigger.click();
    expect((await secondOpen).status()).toBe(200);
    expect(await (await secondOpen).finished()).toBeNull();
    await dialog.getByRole('tab', { name: '附件', exact: true }).click();
    await expect(attachments.getByRole('heading', { name: `附件 · ${seeds.length}`, exact: true })).toBeVisible();

    await selectFile(attachments, 'reports/brief.pdf');
    const pdfFrame = attachments.getByTitle('PDF 预览：reports/brief.pdf');
    await expect(pdfFrame).toBeVisible();
    await expect(pdfFrame).toHaveAttribute('src', attachmentPreviewUrl(project.id, task.id, 'reports/brief.pdf'));
    await paintedPdf(page, pdfFrame, info, pdf, new URL(attachmentPreviewUrl(project.id, task.id, 'reports/brief.pdf'), origin).href);
    await expectCenteredTaskDetail(page, dialog);
    await dialog.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expectReleased();
    expect(graphReads).toBe(1);
    expect(detailReads).toBe(2);
    const thirdOpen = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/tasks/${task.id}`);
    await trigger.click();
    expect((await thirdOpen).status()).toBe(200);
    expect(await (await thirdOpen).finished()).toBeNull();
    await dialog.getByRole('tab', { name: '附件', exact: true }).click();
    await expect(attachments.getByRole('heading', { name: `附件 · ${seeds.length}`, exact: true })).toBeVisible();

    const uploadUrl = new URL(attachmentDownloadUrl(project.id, task.id, uploadedPath), origin).href;
    const upload = async (bytes: Buffer, expectedStatus: number): Promise<void> => {
      if (await uploadDisclosure.getAttribute('open') === null) await uploadSummary.click();
      await attachments.getByLabel('选择一个文件').setInputFiles({ name: 'source.bin', mimeType: 'application/octet-stream', buffer: bytes });
      await expect(attachments.getByRole('textbox', { name: '目标相对路径' })).toHaveValue('source.bin');
      await attachments.getByRole('textbox', { name: '目标相对路径' }).fill(uploadedPath);
      const response = page.waitForResponse((response) => response.url() === uploadUrl && response.request().method() === 'PUT');
      await attachments.getByRole('button', { name: '上传文件', exact: true }).click();
      expect((await response).status()).toBe(expectedStatus);
      await expect(attachments.getByRole('heading', { name: uploadedPath, exact: true })).toBeVisible();
      await expect(attachments.getByRole('textbox', { name: '目标相对路径' })).toHaveValue('');
      expect(await cli.read(args('read', [uploadedPath]))).toEqual(bytes);
    };
    const firstUpload = Buffer.from([0, 255, 8, 13, 10, 0, 128, 61]);
    const overwritten = Buffer.from([254, 0, 2, 255, 128, 10, 13, 0, 42]);
    await upload(firstUpload, 201);
    await upload(overwritten, 200);
    const downloadEvent = page.waitForEvent('download');
    await attachments.getByRole('link', { name: '下载', exact: true }).click();
    const downloaded = await downloadEvent;
    const downloadPath = await downloaded.path();
    if (downloadPath === null) throw new Error('The UI attachment download did not produce an owned file.');
    expect(await readFile(downloadPath)).toEqual(overwritten);
    const deletionRequests: string[] = [];
    page.on('request', (request) => { if (request.method() === 'DELETE') deletionRequests.push(request.url()); });
    await selectFile(attachments, 'long/reading.txt');
    const retainedPreview = attachments.locator('.attachment-preview-body');
    await expect(retainedPreview.locator('pre')).toHaveText(seeds.find(({ path }) => path === 'long/reading.txt')!.bytes.toString('utf8'));
    await expect.poll(() => retainedPreview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await retainedPreview.evaluate((element) => { element.scrollTop = 220; });
    await expect.poll(() => retainedPreview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const retainedScroll = await retainedPreview.evaluate((element) => element.scrollTop);
    const retainedElement = await retainedPreview.elementHandle();
    if (retainedElement === null) throw new Error('The selected attachment preview is absent.');
    const unrelatedPath = 'notes/one/same.txt';
    const unrelatedUrl = new URL(attachmentDownloadUrl(project.id, task.id, unrelatedPath), origin).href;
    const more = await fileActions(attachments, unrelatedPath);
    await more.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: '删除', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await expect(dialog).toBeVisible();
    const cancelled = await confirmDeletion(page, attachments, unrelatedPath);
    await expect(cancelled.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancelled.getByRole('button', { name: '删除附件', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancelled.getByRole('combobox', { name: '语言 / Language', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancelled.locator('.attachment-delete-body')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancelled.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(cancelled).toBeHidden();
    await expect(more).toBeFocused();
    await confirmDeletion(page, attachments, unrelatedPath);
    await page.keyboard.press('Escape');
    await expect(cancelled).toBeHidden();
    await expect(dialog).toBeVisible();
    expect(deletionRequests).toEqual([]);

    const menuLayouts: unknown[] = [];
    for (const locale of ['zh-CN', 'en']) {
      await changeDetailLanguage(locale);
      for (const viewport of [{ width: 1440, height: 800 }, { width: 768, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        await (await fileActions(attachments, longPath)).click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeInViewport({ ratio: 1 });
        const menuBounds = await menu.boundingBox();
        await page.getByRole('menuitem', { name: locale === 'en' ? 'Delete' : '删除', exact: true }).click();
        const confirmation = page.locator('.attachment-delete-dialog');
        await expect(confirmation).toContainText(longPath);
        await expect(confirmation).toBeInViewport({ ratio: 1 });
        await expect(confirmation.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true })).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        menuLayouts.push({ locale, ...viewport, menu: menuBounds, confirmation: await confirmation.boundingBox() });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
      }
    }
    const longPathLayouts: unknown[] = [];
    for (const locale of ['zh-CN', 'en']) {
      await changeDetailLanguage(locale);
      for (const viewport of [{ width: 320, height: 780 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        const confirmation = await confirmDeletion(page, attachments, longConfirmationPath);
        const body = confirmation.locator('.attachment-delete-body');
        const cancel = confirmation.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true });
        const submit = confirmation.getByRole('button', { name: locale === 'en' ? 'Delete attachment' : '删除附件', exact: true });
        await expect(confirmation).toBeInViewport({ ratio: 1 });
        await expect(cancel).toBeFocused();
        await expect(confirmation.locator('header,footer')).toHaveCount(2);
        for (const fixed of [confirmation.locator('header'), confirmation.locator('footer'), cancel, submit]) await expect(fixed).toBeInViewport({ ratio: 1 });
        const metrics = await confirmation.evaluate((element) => {
          const body = element.querySelector<HTMLElement>('.attachment-delete-body')!;
          return { dialogClientHeight: element.clientHeight, dialogScrollHeight: element.scrollHeight, bodyClientHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight, bodyOverflow: getComputedStyle(body).overflowY };
        });
        expect(metrics.dialogScrollHeight).toBeLessThanOrEqual(metrics.dialogClientHeight + 1);
        expect(metrics.bodyOverflow).toMatch(/^(auto|scroll)$/);
        if (viewport.height <= 568) expect(metrics.bodyScrollHeight).toBeGreaterThan(metrics.bodyClientHeight + 1);
        await expect.poll(() => pathEdges(confirmation)).toMatchObject({ prefix: true });
        let wheelTop = 0;
        let keyboardTop = 0;
        if (metrics.bodyScrollHeight > metrics.bodyClientHeight + 1) {
          const bounds = await body.boundingBox();
          if (bounds === null) throw new Error('The confirmation scroll owner has no bounds.');
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, metrics.bodyScrollHeight);
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          await expect.poll(() => pathEdges(confirmation)).toMatchObject({ tail: true });
          wheelTop = await body.evaluate((element) => element.scrollTop);
          await page.keyboard.press('Shift+Tab');
          await expect(body).toBeFocused();
          await page.keyboard.press('Home');
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
          await expect.poll(() => pathEdges(confirmation)).toMatchObject({ prefix: true });
          await page.keyboard.press('End');
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          await expect.poll(() => pathEdges(confirmation)).toMatchObject({ tail: true });
          keyboardTop = await body.evaluate((element) => element.scrollTop);
        } else {
          await expect.poll(() => pathEdges(confirmation)).toEqual({ prefix: true, tail: true });
          await page.keyboard.press('Shift+Tab');
          await expect(body).toBeFocused();
        }
        await page.keyboard.press('Tab');
        await expect(cancel).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(body).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(confirmation.getByRole('combobox', { name: '语言 / Language', exact: true })).toBeFocused();
        for (const fixed of [confirmation.locator('header'), confirmation.locator('footer'), cancel, submit]) await expect(fixed).toBeInViewport({ ratio: 1 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const screenshot = info.outputPath(`attachment-delete-long-path-${locale}-${viewport.width}x${viewport.height}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        await info.attach(`attachment-delete-long-path-${locale}-${viewport.width}x${viewport.height}`, { path: screenshot, contentType: 'image/png' });
        longPathLayouts.push({ locale, ...viewport, pathBytes: Buffer.byteLength(longConfirmationPath), ...metrics, wheelTop, keyboardTop });
        await cancel.click();
        await expect(confirmation).toBeHidden();
        await expect(dialog).toBeVisible();
      }
    }
    await changeDetailLanguage('zh-CN');
    await page.setViewportSize({ width: 1600, height: 1100 });
    expect(deletionRequests).toEqual([]);
    expect(await retainedElement.evaluate((element) => element === document.querySelector('.attachment-preview-body'))).toBe(true);
    expect(await retainedPreview.evaluate((element) => element.scrollTop)).toBe(retainedScroll);

    // The server's real 404 verifies that a stale row stays visible without claiming rollback.
    await command(args('remove', [unrelatedPath]));
    const failedResponse = page.waitForResponse((response) => response.url() === unrelatedUrl && response.request().method() === 'DELETE');
    const failedConfirmation = await confirmDeletion(page, attachments, unrelatedPath);
    await failedConfirmation.getByRole('button', { name: '删除附件', exact: true }).click();
    const failure = await failedResponse;
    expect(failure.status()).toBe(404);
    const failureBody = await failure.json() as { error: { requestId: string } };
    await expect(failedConfirmation.getByRole('alert')).toContainText(failureBody.error.requestId);
    await expect(more).toBeVisible();
    expect(await retainedElement.evaluate((element) => element === document.querySelector('.attachment-preview-body'))).toBe(true);
    expect(await retainedPreview.evaluate((element) => element.scrollTop)).toBe(retainedScroll);
    await put(unrelatedPath, refreshedText, 'restore-delete-retry');
    let releaseDelete!: () => void;
    const heldDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
    await page.route(unrelatedUrl, async (route) => {
      if (route.request().method() === 'DELETE') await heldDelete;
      await route.continue();
    });
    const inventoryPath = `/api/v1/projects/${project.id}/tasks/${task.id}/attachments`;
    let releaseInventory!: () => void;
    const heldInventory = new Promise<void>((resolve) => { releaseInventory = resolve; });
    const inventoryMatcher = (url: URL): boolean => url.pathname === inventoryPath;
    await page.route(inventoryMatcher, async (route) => { await heldInventory; await route.continue(); });
    const inventoryRequest = page.waitForRequest((request) => new URL(request.url()).pathname === inventoryPath && request.method() === 'GET');
    const retryRequest = page.waitForRequest((request) => request.url() === unrelatedUrl && request.method() === 'DELETE');
    const retryResponse = page.waitForResponse((response) => response.url() === unrelatedUrl && response.request().method() === 'DELETE');
    await failedConfirmation.getByRole('button', { name: '删除附件', exact: true }).click();
    try {
      await retryRequest;
      await expect(failedConfirmation.getByRole('button', { name: '正在删除…', exact: true })).toBeDisabled();
      await expect(failedConfirmation.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
      await failedConfirmation.getByRole('button', { name: '正在删除…', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await expect(failedConfirmation).toBeVisible();
      expect(deletionRequests).toEqual([unrelatedUrl, unrelatedUrl]);
    } finally { releaseDelete(); }
    try {
      expect((await retryResponse).status()).toBe(204);
      await inventoryRequest;
      await expect(failedConfirmation).toBeHidden();
      await expect.poll(() => page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && active !== document.body && active.closest('.task-attachments') !== null && !active.matches(':disabled');
      }), { message: 'Successful deletion restores focus while inventory reload is still pending' }).toBe(true);
    } finally { releaseInventory(); await page.unroute(inventoryMatcher); await page.unroute(unrelatedUrl); }
    await expect(attachments.getByRole('heading', { name: `附件 · ${seeds.length}`, exact: true })).toBeVisible();
    expect(await retainedElement.evaluate((element) => element === document.querySelector('.attachment-preview-body'))).toBe(true);
    expect(await retainedPreview.evaluate((element) => element.scrollTop)).toBe(retainedScroll);
    await retainedElement.dispose();
    expect(await cli.read(args('read', ['notes/two/same.txt']))).toEqual(Buffer.from('Second same-name text\n'));

    await selectFile(attachments, 'site/index.html');
    const retainedFrame = attachments.locator('iframe');
    await retainedFrame.contentFrame().getByRole('button', { name: '完成一个任务' }).click();
    const retainedFrameElement = await retainedFrame.elementHandle();
    const nativeDelete = await confirmDeletion(page, attachments, 'notes/two/same.txt');
    const nativeResponse = page.waitForResponse((response) => response.url() === new URL(attachmentDownloadUrl(project.id, task.id, 'notes/two/same.txt'), origin).href && response.request().method() === 'DELETE');
    await nativeDelete.getByRole('button', { name: '删除附件', exact: true }).click();
    expect((await nativeResponse).status()).toBe(204);
    await expect(nativeDelete).toBeHidden();
    expect(await retainedFrameElement!.evaluate((element) => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    await expect(retainedFrame.contentFrame().locator('#result')).toHaveText('已完成 3 个任务');
    await retainedFrameElement!.dispose();

    await selectFile(attachments, uploadedPath);
    const deletion = page.waitForResponse((response) => response.url() === uploadUrl && response.request().method() === 'DELETE');
    const selectedDelete = await confirmDeletion(page, attachments, uploadedPath);
    await selectedDelete.getByRole('button', { name: '删除附件', exact: true }).click();
    expect((await deletion).status()).toBe(204);
    await expect(attachments.getByRole('heading', { name: `附件 · ${seeds.length - 2}`, exact: true })).toBeVisible();
    expect(deletionRequests).toHaveLength(4);
    await info.attach('attachment-delete-confirmation', { body: Buffer.from(JSON.stringify({ zeroRequestsBeforeConfirmation: true, requests: deletionRequests, failureStatus: failure.status(), failureRequestId: failureBody.error.requestId, menuLayouts, longPathLayouts }, null, 2)), contentType: 'application/json' });
    await expect(attachments.getByRole('region', { name: '附件预览', exact: true })).toHaveCount(0);
    const finalList = JSON.parse(await command(args('list', ['--json']))) as { path: string }[];
    expect(finalList.map(({ path }) => path)).toEqual(seeds.filter(({ path }) => !['notes/one/same.txt', 'notes/two/same.txt'].includes(path)).map(({ path }) => path).toSorted());
    const absent = await cli.run(args('read', [uploadedPath]));
    expect(absent.exitCode).not.toBe(0);
    expect(absent.stdout).toBe('');
    expect(absent.stderr).toMatch(/not found/i);
    const taskResponse = await request.get(`/api/v1/projects/${project.id}/tasks/${task.id}`);
    expect(taskResponse.status()).toBe(200);
    const finalTask = await taskResponse.json() as Task;
    expect(finalTask.version).toBe(task.version);
    expect(finalTask.updatedAt).toBe(task.updatedAt);
    expect(graphReads, 'Attachment writes do not refresh the task graph').toBe(1);
    expect(detailReads, 'Attachment writes do not refresh task details beyond the three deliberate opens').toBe(3);
    const screenshot = info.outputPath('task-attachments.png');
    await page.screenshot({ path: screenshot, fullPage: false });
    await info.attach('task-attachments', { path: screenshot, contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expectReleased();
  } finally { await cli.close(); }
});
