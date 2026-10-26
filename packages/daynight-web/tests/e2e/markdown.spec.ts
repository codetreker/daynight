import { openChain } from './chain-dialog';
import { selectTaskList } from './project-view';
import { decodeTaskGraphJson } from '../../src/api/project-json';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { attachmentDownloadUrl, attachmentPageUrl, attachmentPreviewUrl } from '../../src/api/client';
import { parseTaskGraph } from '../../src/api/parse';
import { createAcceptanceCli } from '../../scripts/acceptance/installed-cli.mts';
import { createProject, createTask, expect, test, updateTask } from './fixtures';
import { captureStableDependencyGeometry, checkDependencyGeometry, expectedDependencyTopology } from './dependency-geometry';
import { expectCenteredTaskDetail } from './detail-dialog';
import { observeGraphCardVisibility } from './task-card-visibility';

const capture = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
};
const overview = (dialog: Locator): Locator => dialog.locator('.task-detail-panel-overview');

const expectGraphCardFullyVisible = async (body: Locator, info: TestInfo): Promise<void> => {
  let observation: ReturnType<typeof observeGraphCardVisibility> | undefined;
  try {
    // The transformed body fills its parent's clip exactly. Check containment
    // before and after scaling; IntersectionObserver remaps its rectangles.
    // https://www.w3.org/TR/intersection-observer/#calculate-intersection-rect-algo
    await expect.poll(async () => {
      observation = await body.evaluate(observeGraphCardVisibility);
      return observation.failures;
    }, { message: 'The full card and native inspection control fit every actual clip without a geometric tolerance' }).toEqual([]);
    await expect(body).toBeVisible();
    await expect(body).toBeInViewport();
    await expect(body).toBeFocused();
  } catch (error) {
    await info.attach('markdown-graph-card-visibility', { body: Buffer.from(JSON.stringify({ observation, error: String(error) }, null, 2)), contentType: 'application/json' });
    throw error;
  }
};

const columns = Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`);
const wideTable = `| ${columns.join(' | ')} |\r\n| ${columns.map(() => '---').join(' | ')} |\r\n| ${columns.map(() => 'Long unbroken table content').join(' | ')} |`;
const longCode = `const taskDescription = '${'markdown-reference-'.repeat(60)}';`;
const namedPath = 'docs/设计 #?%.md';
const flowchartTD = [
  'flowchart TD',
  '    A["<b>开始</b>"] --> B{是否通过？}',
  '    B -->|是| C[完成]',
  '    B -->|否| D[修改]',
  '    D --> B',
  '    click A "javascript:window.flowchartLeak=true"',
].join('\n');
const flowchartLR = [
  'flowchart LR',
  '    A@{ shape: rect, label: "提交包含中文与 English 的完整方案和详细验收条件" } --> B[核对任务描述和附件中的流程图]',
  '    B --> C[在窄屏中水平滚动阅读全部节点与箭头]',
  '    C --> D["验证通过后完成交付，保留 @{ 字面标签"]',
].join('\n');
const invalidFlowchart = 'flowchart TD\n    A[未闭合节点 --> B';
const unsafeFlowchart = '%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%\nflowchart TD\n    A[Unsafe override] --> B[Refused]';
const heldImageUrl = 'https://flowchart-resource.invalid/held.svg';
const imageFlowchart = `flowchart TD\n    A@{ img: "${heldImageUrl}", label: "Image" } --> B`;
const escapedImageFlowchart = String.raw`flowchart TD
    A@{ "im\u0067": "${heldImageUrl}", label: "Escaped image" } --> B`;
const imageShapeFlowchart = 'flowchart TD\n    A@{ shape: imageSquare } --> B';
const failedFlowcharts = [imageFlowchart, escapedImageFlowchart, imageShapeFlowchart, invalidFlowchart, unsafeFlowchart];
const fenced = (source: string): string => `\`\`\`mermaid\n${source}\n\`\`\``;
const flowchartMarkdown = [
  '## 流程图 Flowcharts', '', fenced(imageFlowchart), '', fenced(escapedImageFlowchart), '', fenced(imageShapeFlowchart), '',
  fenced(flowchartTD), '', fenced(flowchartLR), '',
  '无效图块保持局部失败，正文与其余图形继续可读。', '', fenced(invalidFlowchart), '', fenced(unsafeFlowchart), '',
].join('\n');

const expectFlowcharts = async (container: Locator): Promise<void> => {
  const diagrams = container.locator('.mermaid-diagram');
  await expect(container.locator('.mermaid-flowchart')).toHaveCount(7);
  await expect(diagrams).toHaveCount(2);
  for (const diagram of await diagrams.all()) {
    const image = diagram.getByRole('img');
    await expect(image).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
  const drawings = await diagrams.locator('img').evaluateAll(async (images) => Promise.all(images.map(async (image) => {
    const text = await (await fetch((image as HTMLImageElement).src)).text();
    const svg = new DOMParser().parseFromString(text, 'image/svg+xml');
    const attributes = [...svg.querySelectorAll('*')].flatMap((element) => [...element.attributes]);
    return { text: svg.documentElement.textContent, paths: svg.querySelectorAll('path').length,
      scripts: svg.querySelectorAll('script, foreignObject').length,
      events: attributes.filter((attribute) => /^on/i.test(attribute.name)).map((attribute) => attribute.name),
      references: attributes.filter((attribute) => attribute.localName === 'href').map((attribute) => attribute.value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase()) };
  })));
  expect(drawings[0]!.text).toContain('开始');
  expect(drawings[0]!.text).toContain('是否通过？');
  expect(drawings[0]!.text).toContain('完成');
  expect(drawings[0]!.paths).toBeGreaterThanOrEqual(5);
  const horizontalLabels = drawings[1]!.text!.replace(/\s+/g, '');
  expect(horizontalLabels).toContain('包含中文与English');
  expect(horizontalLabels).toContain('@{字面标签');
  for (const drawing of drawings) {
    expect(drawing.scripts).toBe(0);
    expect(drawing.events).toEqual([]);
    expect(drawing.references.filter((reference) => /^(?:javascript|vbscript):|^data:(?:text\/html|image\/svg\+xml)/.test(reference))).toEqual([]);
  }
  await diagrams.first().getByRole('img').click();
  const failures = container.locator('.mermaid-flowchart').filter({ has: container.page().getByRole('alert') });
  await expect(failures).toHaveCount(failedFlowcharts.length);
  for (const [index, source] of failedFlowcharts.entries()) await expect(failures.nth(index).locator('pre code')).toHaveText(source);
  for (const failure of (await failures.all()).slice(0, 2)) {
    await expect(failure.getByRole('alert')).toContainText(/Image nodes are not supported|不支持图片节点/);
  }
  expect(await container.page().evaluate(() => Object.hasOwn(window, 'flowchartLeak'))).toBe(false);
};
const markdown = [
  '# 交付说明 Delivery', '',
  '任务描述保存 **原始 Markdown**，并直接访问任务附件。', '',
  '## Scope 范围', '',
  '- 阅读中文和 English', '- [x] 保留完整描述', '',
  '> 可见结果：在当前任务详情中打开附件。', '',
  flowchartMarkdown, '', wideTable, '', '```typescript', longCode, '```', '',
  '![流程图](images/workflow.svg)', '',
  '[方案与验收](plan.md)', '', '[交互原型](site/index.html)', '',
  `[编码文件](docs/${encodeURIComponent('设计 #?%.md')})`, '',
  '[缺失文件](absent.md)', '', '[越界路径](../outside.md)', '',
  '[普通查询](plan.md?raw=1#section)', '', '[文档片段](#scope)', '',
  '[外部资料](https://example.com/reference)', '', '[根路径](/)', '',
  '[危险协议](javascript:alert%281%29)', '',
  '<script>window.descriptionLeak = true</script>', '',
].join('\r\n');

test('task-description-markdown', { annotation: { type: 'scenario', description: 'task-description-markdown' } }, async ({ page, api: request }, info) => {
  const project = await createProject(request, { name: `Markdown ${randomUUID()}` });
  const task = await createTask(request, project.id, { title: 'Markdown 描述与真实附件导航' });
  const emptyTask = await createTask(request, project.id, { title: '空描述 Empty description' });
  const baseURL = info.project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('Markdown acceptance requires the actual service base URL.');
  const cli = await createAcceptanceCli(baseURL, info.outputPath('installed-cli'));
  const resourceRequests: string[] = [];
  let releaseResource!: () => void;
  const heldResource = new Promise<void>((resolve) => { releaseResource = resolve; });
  await page.context().route(heldImageUrl, async (route) => {
    resourceRequests.push(route.request().url());
    await heldResource;
    await route.abort();
  });
  try {
    const update = await cli.run(['task', 'update', task.id, '--project', project.id, '--if-version', String(task.version), '--description', markdown]);
    expect(update.exitCode, 'Installed CLI writes Markdown without normalization').toBe(0);
    expect(update.stderr).toBe('');
    const shown = await cli.run(['task', 'show', task.id, '--project', project.id, '--json']);
    expect(shown.exitCode).toBe(0);
    expect((JSON.parse(shown.stdout) as { description: string }).description).toBe(markdown);
    const taskUrl = `/api/v1/projects/${project.id}/tasks/${task.id}`;
    const read = await request.get(taskUrl);
    const before = await read.json() as { description: string; version: number };
    expect(before.description).toBe(markdown);
    const replacement = markdown.replace('原始 Markdown', '完整 Markdown');
    const replaced = await request.patch(taskUrl, { data: { version: before.version, description: replacement } });
    expect(replaced.status(), 'A versioned update replaces the complete Markdown string').toBe(200);
    const after = await replaced.json() as { description: string; version: number };
    expect(after.description).toBe(replacement);
    expect(after.version).toBe(before.version + 1);
    const reread = await request.get(taskUrl);
    expect((await reread.json() as { description: string }).description).toBe(replacement);
    const stale = await request.patch(taskUrl, { data: { version: before.version, description: 'stale replacement' } });
    expect(stale.status(), 'A stale version cannot overwrite current Markdown').toBe(409);

    const put = async (path: string, data: string, contentType: string): Promise<void> => {
      const response = await request.put(attachmentDownloadUrl(project.id, task.id, path), { data, headers: { 'content-type': contentType } });
      expect(response.status(), `Seed real attachment ${path}`).toBe(201);
    };
    // The linked plan sorts onto page two, so navigation must wait for a complete inventory.
    for (let index = 0; index < 101; index++) await put(`aa-fixture/${String(index).padStart(3, '0')}.txt`, `Pagination fixture ${index}`, 'text/plain');
    await put('plan.md', `# 方案与验收\n\n[嵌套资料](docs/child.md)\n\n![附件相对图片](images/workflow.svg)\n\n${flowchartMarkdown}`, 'text/markdown');
    await put('docs/child.md', `# Nested child\n\nTask-root plan attachment.\n\n${fenced('flowchart TD\n    Fresh[当前附件] --> Only[仅一张图]')}`, 'text/markdown');
    await put(namedPath, '# 编码文件内容\n\n中文、空格和保留字符保持路径身份。\n', 'text/markdown');
    await put('images/workflow.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64"><rect width="160" height="64" fill="#2255aa"/><text x="8" y="36" fill="white">Markdown image</text></svg>', 'image/svg+xml');
    await put('site/index.html', '<!doctype html><html lang="en"><head><title>Description attachment</title></head><body><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button></body></html>', 'text/html');
    const listPath = `/api/v1/projects/${project.id}/tasks/${task.id}/attachments`;
    const listRequests: string[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname === listPath) listRequests.push(request.url()); });
    let releasePage!: () => void;
    const heldPage = new Promise<void>((resolve) => { releasePage = resolve; });
    let failSecondPage = true;
    await page.route((url) => url.pathname === listPath && url.searchParams.has('cursor'), async (route) => {
      if (!failSecondPage) return route.continue();
      failSecondPage = false;
      await heldPage;
      await route.abort('connectionfailed');
    });
    const clockTime = new Date('2030-01-01T00:00:00Z');
    await page.clock.install({ time: clockTime });
    await page.clock.pauseAt(clockTime);
    await page.goto(`/projects/${project.id}`);
    await selectTaskList(page);
    await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    const trigger = page.locator(`#standalone-task-${task.id}`);
    await trigger.click();
    const dialog = page.locator('.task-detail-dialog[role="dialog"]');
    const description = overview(dialog).locator('.task-description');
    await expect(description.getByRole('heading', { name: '交付说明 Delivery', exact: true })).toBeVisible();
    await expect(description.getByRole('table')).toHaveCount(1);
    await expect(description.locator('blockquote')).toContainText('可见结果');
    const ordinaryCode = description.locator('pre:has(code.language-typescript)');
    await expect(ordinaryCode).toHaveText(longCode);
    await expectFlowcharts(description);
    const firstSource = description.locator('.mermaid-flowchart').nth(3);
    await firstSource.locator('summary').click();
    await expect(firstSource.locator('pre code')).toBeVisible();
    await expect(firstSource.locator('pre code')).toHaveText(flowchartTD);
    await firstSource.locator('summary').click();
    await expect(description.locator('input[type="checkbox"]')).toBeChecked();
    await expect(description.locator('script')).toHaveCount(0);
    await expect(description.getByText('<script>window.descriptionLeak = true</script>')).toBeVisible();
    expect(await page.evaluate(() => Object.hasOwn(window, 'descriptionLeak'))).toBe(false);
    await expect(description.locator('a').filter({ hasText: /^危险协议$/ })).toHaveAttribute('href', '');
    await expect(description.getByRole('link', { name: '文档片段', exact: true })).toHaveAttribute('href', '#scope');
    await expect(description.getByRole('link', { name: '外部资料', exact: true })).toHaveAttribute('href', 'https://example.com/reference');
    await expect(description.getByRole('link', { name: '根路径', exact: true })).toHaveAttribute('href', '/');
    await expect(description.getByRole('link', { name: '普通查询', exact: true })).toHaveAttribute('href', `${attachmentPreviewUrl(project.id, task.id, 'plan.md')}?raw=1#section`);
    const image = description.locator('p > img[alt="流程图"]');
    await expect(image).toHaveAttribute('src', attachmentPreviewUrl(project.id, task.id, 'images/workflow.svg'));
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(dialog.locator('.task-attachments').getByRole('heading', { name: '附件 · 106', exact: true })).toBeHidden();
    await expect.poll(() => listRequests.length).toBe(2);

    await page.setViewportSize({ width: 1440, height: 900 });
    const planLink = description.getByRole('link', { name: '方案与验收', exact: true });
    await expect(planLink).toHaveAttribute('href', attachmentPreviewUrl(project.id, task.id, 'plan.md'));
    const readerPromise = page.context().waitForEvent('page');
    await description.getByRole('link', { name: '交互原型', exact: true }).click({ modifiers: ['ControlOrMeta'] });
    const reader = await readerPromise;
    try {
      await reader.waitForURL(`**${attachmentPreviewUrl(project.id, task.id, 'site/index.html')}`);
      await expect(reader.getByRole('button', { name: '0', exact: true })).toBeVisible();
      await reader.reload();
      await expect(reader.getByRole('button', { name: '0', exact: true })).toBeVisible();
    } finally { await reader.close(); }
    await expect(dialog.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
    await planLink.click();
    const attachments = dialog.locator('.task-attachments');
    await expect(dialog.getByRole('tab', { name: '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
    const previewPane = attachments.locator('.attachment-preview-pane');
    await expect(previewPane.getByRole('status')).toBeVisible();
    await expect(previewPane).toBeFocused();
    await expect(previewPane.getByRole('alert')).toHaveCount(0);
    releasePage();
    await expect(previewPane.getByRole('alert')).toContainText('附件列表尚未完整加载');
    await expect(previewPane.getByText('找不到此附件，文件可能已被删除。')).toHaveCount(0);
    await previewPane.getByRole('button', { name: '重试附件', exact: true }).click();
    await expect(attachments.getByRole('heading', { name: 'plan.md', exact: true })).toBeVisible();
    expect(listRequests.length, 'Retry reads every real inventory page').toBe(4);
    await expectFlowcharts(previewPane);
    await capture(page, info, 'flowchart-attachment-preview');
    const flowchartReader = await page.context().newPage();
    const readerErrors: string[] = [];
    flowchartReader.on('pageerror', (error) => readerErrors.push(error.message));
    try {
      await flowchartReader.goto(attachmentPageUrl(project.id, task.id, 'plan.md'));
      await expectFlowcharts(flowchartReader.locator('.attachment-preview-body'));
      await flowchartReader.reload();
      await expectFlowcharts(flowchartReader.locator('.attachment-preview-body'));
      await flowchartReader.setViewportSize({ width: 320, height: 800 });
      const readerContent = flowchartReader.locator('.attachment-preview-body');
      expect(await flowchartReader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await readerContent.locator('.mermaid-diagram').nth(1).scrollIntoViewIfNeeded();
      await capture(flowchartReader, info, 'flowchart-standalone-reader-320');
      const docsDirectory = flowchartReader.locator('.attachment-sidebar summary').filter({ hasText: /^▱ docs$/ }).locator('..');
      await expect(docsDirectory).toHaveCount(1);
      if (await docsDirectory.getAttribute('open') === null) await docsDirectory.locator(':scope > summary').click();
      await docsDirectory.locator('.attachment-file-name').filter({ hasText: /^child\.md$/ }).locator('..').click();
      await expect(flowchartReader).toHaveURL(new URL(attachmentPageUrl(project.id, task.id, 'docs/child.md'), baseURL).href);
      await expect(flowchartReader.locator('.attachment-preview-body .mermaid-flowchart')).toHaveCount(1);
      await expect.poll(() => flowchartReader.locator('.attachment-preview-body .mermaid-diagram img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      expect(await flowchartReader.locator('.attachment-preview-body .mermaid-flowchart').textContent()).not.toContain('未闭合节点');
      await flowchartReader.goBack();
      await expectFlowcharts(flowchartReader.locator('.attachment-preview-body'));
      expect(readerErrors).toEqual([]);
    } finally { await flowchartReader.close(); }
    const readsBeforeNavigation = listRequests.length;
    await expect(attachments.getByRole('link', { name: '嵌套资料', exact: true })).toHaveAttribute('href', attachmentPreviewUrl(project.id, task.id, 'docs/child.md'));
    expect(listRequests.length, 'Description navigation reuses the complete attachment inventory').toBe(readsBeforeNavigation);
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await description.getByRole('link', { name: '缺失文件', exact: true }).click();
    await expect(previewPane.getByRole('alert')).toContainText('找不到此附件，文件可能已被删除。');
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await description.locator('a').filter({ hasText: /^越界路径$/ }).click();
    await expect(previewPane.getByRole('alert')).toContainText('此附件引用无效或超出了任务附件根目录。');
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await page.route(`**${attachmentDownloadUrl(project.id, task.id, namedPath)}`, (route) => route.abort('connectionfailed'), { times: 1 });
    await description.getByRole('link', { name: '编码文件', exact: true }).click();
    await expect(attachments.getByRole('heading', { name: namedPath, exact: true })).toBeVisible();
    await expect(previewPane.getByRole('alert')).toContainText('无法读取文件预览');
    await previewPane.getByRole('button', { name: '重试预览', exact: true }).click();
    await expect(attachments.getByRole('heading', { name: '编码文件内容', exact: true })).toBeVisible();
    expect(listRequests.length, 'Missing, invalid and encoded references share one inventory').toBe(readsBeforeNavigation);
    const overwrite = await request.put(attachmentDownloadUrl(project.id, task.id, namedPath), { data: `# 已覆盖内容\n\n当前路径的新修订。\n\n${fenced('flowchart TD\n    Updated[更新内容] --> Current[新修订]')}`, headers: { 'content-type': 'text/markdown' } });
    expect(overwrite.status()).toBe(200);
    await attachments.getByRole('button', { name: '刷新附件', exact: true }).click();
    await expect(attachments.getByRole('heading', { name: '已覆盖内容', exact: true })).toBeVisible();
    await expect(previewPane.locator('.mermaid-flowchart')).toHaveCount(1);
    await expect.poll(() => previewPane.locator('.mermaid-diagram img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await previewPane.locator('.mermaid-diagram img').evaluate(async (image) => (await (await fetch((image as HTMLImageElement).src)).text()))).toContain('更新内容');
    expect(listRequests.length, 'An explicit refresh reads each inventory page once').toBe(6);
    for (const locale of ['en', 'zh-CN']) {
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      await trigger.click();
      await expect(dialog.locator('.task-detail-header').getByRole('combobox')).toHaveCount(0);
      await expect(dialog).toHaveAccessibleName(task.title);
      await expect(attachments.locator('.attachment-section-heading > h4')).toHaveText(locale === 'en' ? 'Attachments · 106' : '附件 · 106');
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await expectCenteredTaskDetail(page, dialog);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await description.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await ordinaryCode.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        await expectFlowcharts(description);
        if (width === 320) {
          const wideDiagram = description.locator('.mermaid-diagram').nth(1);
          expect(await wideDiagram.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
          await wideDiagram.focus();
          await wideDiagram.press('ArrowRight');
          await expect.poll(() => wideDiagram.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
          await wideDiagram.scrollIntoViewIfNeeded();
          await capture(page, info, `flowchart-description-${locale}-${width}`);
        }
        if (width === 320) expect(await description.locator('.markdown-table').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        await capture(page, info, `task-description-${locale}-${width}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await description.getByRole('link', { name: '交互原型', exact: true }).click();
    const frame = attachments.locator('iframe');
    await expect(frame).toHaveAttribute('src', attachmentPreviewUrl(project.id, task.id, 'site/index.html'));
    const button = attachments.frameLocator('iframe').getByRole('button', { name: '0', exact: true });
    await button.click();
    await expect(attachments.frameLocator('iframe').getByRole('button', { name: '1', exact: true })).toBeVisible();
    await attachments.frameLocator('iframe').getByRole('button').press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.locator(`#standalone-task-${emptyTask.id}`).click();
    await expect(overview(page.locator('.task-detail-dialog')).getByRole('region', { name: '描述', exact: true })).toContainText('暂无描述');
    await page.keyboard.press('Escape');
    await test.step('preserves graph inspection while description links open the shared attachment reader', async () => {
      const ancestor = await createTask(request, project.id, { title: 'Markdown graph ancestor' });
      const prerequisite = await createTask(request, project.id, { title: 'Markdown graph prerequisite', dependsOn: [ancestor.id] });
      await updateTask(request, project.id, task.id, { version: after.version, dependsOn: [prerequisite.id] });
      await createTask(request, project.id, { title: 'Markdown graph successor', dependsOn: [task.id] });
      await createTask(request, project.id, { title: 'Markdown graph sibling', dependsOn: [ancestor.id] });
      const graphResponse = await request.get(`/api/v1/projects/${project.id}/task-graph`);
      expect(graphResponse.status()).toBe(200);
      const snapshot = parseTaskGraph(await decodeTaskGraphJson(new Response(await graphResponse.text())), project.id);
      const expected = expectedDependencyTopology(snapshot.tasks, ancestor.id);
      const byId = new Map(snapshot.tasks.map((entry) => [entry.id, entry]));
      const upstream = new Set<string>(); const pending = [task.id];
      while (pending.length > 0) for (const id of byId.get(pending.pop()!)!.dependsOn) {
        if (!upstream.has(id)) { upstream.add(id); pending.push(id); }
      }
      const highlighted = new Set([task.id, ...upstream]);
      await page.goto(`/projects/${project.id}`);
      await selectTaskList(page);
      await page.getByRole('tab', { name: '任务链', exact: true }).click();
      await openChain(page, ancestor.id);
      const graph = page.locator('.task-graph');
      await expect(graph).toHaveAttribute('data-visible-task-count', String(expected.nodes.length));
      await expect(graph).toHaveAttribute('data-total-task-count', String(expected.nodes.length));
      const body = page.locator(`.react-flow__node[data-id="${task.id}"] .task-node-body`);
      const details = page.locator(`.react-flow__node[data-id="${task.id}"] .task-node-details`);
      await page.keyboard.press('Tab');
      const canvas = graph.locator('.task-graph-canvas');
      await canvas.scrollIntoViewIfNeeded();
      await expect(canvas).toBeInViewport({ ratio: 1 });
      await body.focus();
      await expectGraphCardFullyVisible(body, info);
      const beforeSelection = (await page.evaluate(captureStableDependencyGeometry)).geometry;
      await page.keyboard.press('Enter');
      await expect(body).toHaveAttribute('aria-pressed', 'true');
      await expect(graph).toHaveAttribute('data-hidden-upstream-count', '0');
      const inspection = () => page.evaluate(() => ({
        nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => ({
          id: node.dataset.id!, state: node.querySelector<HTMLElement>('.task-node')!.dataset.inspection,
          pressed: node.querySelector('.task-node-body')!.getAttribute('aria-pressed'),
        })).sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...document.querySelectorAll<SVGGElement>('.task-dependency-edge')].map((edge) => ({ id: edge.dataset.id!, state: edge.dataset.inspection })).sort((a, b) => a.id.localeCompare(b.id)),
        hidden: document.querySelector<HTMLElement>('.task-graph')!.dataset.hiddenUpstreamCount,
      }));
      const selectedState = {
        nodes: expected.nodes.map(({ id }) => ({ id, state: id === task.id ? 'selected' : upstream.has(id) ? 'prerequisite' : 'unrelated', pressed: String(id === task.id) })).sort((a, b) => a.id.localeCompare(b.id)),
        edges: expected.edges.map(({ id, source, target }) => ({ id, state: highlighted.has(source) && highlighted.has(target) ? 'highlighted' : 'unrelated' })).sort((a, b) => a.id.localeCompare(b.id)),
        hidden: '0',
      };
      expect(await inspection()).toEqual(selectedState);
      expect((await page.evaluate(captureStableDependencyGeometry)).geometry).toEqual(beforeSelection);
      expect(await checkDependencyGeometry(page, expected, info)).toEqual({ total: 0, examples: [] });
      const readsBeforeDetails = listRequests.length;
      await details.click();
      await expectCenteredTaskDetail(page, dialog);
      await expect(description.getByRole('heading', { name: '交付说明 Delivery', exact: true })).toBeVisible();
      await description.getByRole('link', { name: '方案与验收', exact: true }).click();
      await expect(dialog.getByRole('tab', { name: '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(previewPane).toBeFocused();
      await expect(attachments.getByRole('heading', { name: '方案与验收', exact: true })).toBeVisible();
      expect(listRequests.length, 'Graph Details and Markdown navigation share one complete attachment inventory').toBe(readsBeforeDetails + 2);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(details).toBeFocused();
      expect(await inspection(), 'Closing the attachment reader retains every graph inspection role').toEqual(selectedState);
      expect((await page.evaluate(captureStableDependencyGeometry)).geometry, 'Description attachment navigation retains all visible nodes, routes, paint owners and viewport').toEqual(beforeSelection);
      expect(await checkDependencyGeometry(page, expected, info)).toEqual({ total: 0, examples: [] });
      await capture(page, info, 'task-description-graph-inspection');
    });
    expect(resourceRequests, 'Image nodes are refused before rendering can start any held resource request').toEqual([]);
    const directory = info.outputPath('markdown-evidence');
    await mkdir(directory, { recursive: true });
    const receipt = join(directory, 'source.json');
    await writeFile(receipt, `${JSON.stringify({ scenario: 'task-description-markdown', taskId: task.id, descriptionBytes: Buffer.byteLength(replacement), attachments: 106, flowcharts: { validPerDocument: 2, isolatedErrorsPerDocument: failedFlowcharts.length, imageResourceRequests: resourceRequests, entries: ['description', 'attachment-preview', 'standalone-reader'], inertSvgImages: true }, listRequests: listRequests.length, source: 'tests/e2e/markdown.spec.ts' }, null, 2)}\n`);
    await info.attach('task-description-markdown-source', { path: receipt, contentType: 'application/json' });
  } finally { releaseResource(); await cli.close(); }
});
