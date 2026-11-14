import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { stableDiagrams } from './mermaid-stable-fixture';
import { captureStableDependencyGeometry, checkDependencyGeometry, expectedDependencyTopology } from '../helpers/dependency-geometry';
import { expectDescriptionCard } from '../helpers/description-card';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const personalId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const root = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const longCode = 'const longValue = "' + 'content'.repeat(80) + '";';
const flow = 'flowchart LR\nA[开始] --> B{是否通过？}\nB --> C[完成]';
const event = 'eventmodeling\n\ntf 01 ui DeleteProjectUI\ntf 02 cmd DeleteProject\ntf 03 evt ProjectDeleted';
const description = `# Delivery\n\n[Read plan](plan.md)\n\n\`\`\`ts\n${longCode}\n\`\`\`\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n\n\`\`\`mermaid\n${event}\n\`\`\``;

async function install(page: Page, descriptionOverride = description, chain = false, locale = 'en') {
  const task = detailFixture(projectId, taskId, { title: 'Markdown reading', description: descriptionOverride, version: 5n });
  const successor = detailFixture(projectId, '00000000-0000-4000-8000-000000000042', { title: 'Successor', dependsOn: [taskId], version: 5n });
  const graph = graphFixture(chain ? [task, successor] : [task]);
  const state = { writes: [] as string[], attachmentLists: 0 };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    if (path === root) return route.fulfill({
      body: stringifyWireJson(task),
      headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': taskSyncEpoch(projectId) },
    });
    if (path === `${root}/attachments`) { state.attachmentLists++; return send({ items: [{ path: 'plan.md', contentType: 'text/markdown', sizeBytes: 19, createdAt: time, updatedAt: time }], nextCursor: null }); }
    if (path === `${root}/attachments/files/plan.md`) return route.fulfill({ body: '# Plan\n\nReady.', headers: { 'Content-Type': 'text/markdown', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/sessions`) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return Object.assign(state, { graph });
}

async function open(page: Page) {
  await page.goto(`/projects/${projectId}/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: 'Delivery', exact: true })).toBeVisible();
}

test('real Mermaid diagrams render labeled SVG images and event labels affect painted pixels', async ({ page }) => {
  const state = await install(page); await open(page);
  const charts = page.locator('.mermaid-chart'); await expect(charts).toHaveCount(2);
  for (const [index, labels] of [['开始', '是否通过？', '完成'], ['DeleteProjectUI', 'DeleteProject', 'ProjectDeleted']].entries()) {
    const image = charts.nth(index).getByRole('img');
    await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { timeout: 45_000 }).toBe(true);
    const svg = await image.evaluate(async (element: HTMLImageElement) => {
      const xml = new DOMParser().parseFromString(await (await fetch(element.src)).text(), 'image/svg+xml');
      return { text: xml.documentElement.textContent ?? '', viewBox: xml.documentElement.getAttribute('viewBox'), width: xml.documentElement.getAttribute('width'), height: xml.documentElement.getAttribute('height'), scripts: xml.querySelectorAll('script').length };
    });
    for (const label of labels) expect(svg.text).toContain(label);
    expect(svg.viewBox).toBeTruthy(); expect(Number(svg.width)).toBeGreaterThan(0); expect(Number(svg.height)).toBeGreaterThan(0); expect(svg.scripts).toBe(0);
  }
  const image = charts.nth(1).getByRole('img'); await image.scrollIntoViewIfNeeded();
  const original = await image.screenshot();
  const urls = await image.evaluate(async (element: HTMLImageElement) => {
    const original = element.src;
    const xml = new DOMParser().parseFromString(await (await fetch(original)).text(), 'image/svg+xml');
    const labels = xml.querySelectorAll('foreignObject'); if (labels.length < 3) throw new Error('Expected event labels');
    labels.forEach(label => label.setAttribute('visibility', 'hidden'));
    const hidden = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(xml)], { type: 'image/svg+xml' }));
    element.src = hidden; await element.decode(); return { original, hidden };
  });
  try {
    const hidden = await image.screenshot();
    const changed = await page.evaluate(async ({ first, second }) => {
      const read = async (data: string) => {
        const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0); bitmap.close(); return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const a = await read(first), b = await read(second); if (a.width !== b.width || a.height !== b.height) throw new Error('Image size changed');
      let count = 0; for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 30) count++;
      return count;
    }, { first: original.toString('base64'), second: hidden.toString('base64') });
    expect(changed).toBeGreaterThan(100);
  } finally { await image.evaluate((element: HTMLImageElement, value) => { element.src = value.original; URL.revokeObjectURL(value.hidden); }, urls); }
  expect(state.writes).toEqual([]);
});

test('narrow description keeps long code and diagrams locally scrollable and opens its attachment', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const state = await install(page); await open(page);
  const description = page.locator('.task-description');
  const code = description.locator('pre').filter({ hasText: longCode });
  await expect(code).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await code.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  const diagram = description.locator('.mermaid-diagram').first();
  await expect(diagram.getByRole('img')).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
  expect(await diagram.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await diagram.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => diagram.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const link = description.getByRole('link', { name: 'Read plan' });
  await expect(link).toHaveAttribute('href', `${root}/preview/plan.md`); await link.click();
  await expect(page.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.attachment-preview-pane')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
  expect(state.attachmentLists).toBe(1); expect(state.writes).toEqual([]);
});

// The production reader must render each supported diagram with the actual
// Mermaid engine. Unsupported and unsafe sources remain readable as source.
test('supported Mermaid types render and rejected sources stay readable without loading resources', async ({ page }) => {
  test.setTimeout(120_000);
  const rejected = ['mindmap\n  root((Experimental))', 'flowchart TD\nA[unclosed --> B', '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA --> B', 'flowchart TD\nA@{ img: "https://flowchart-resource.invalid/held.svg", label: "Image" } --> B', String.raw`flowchart TD\nA@{ "im\u0067": "https://flowchart-resource.invalid/held.svg", label: "Escaped" } --> B`.replace('\\n', '\n'), 'flowchart TD\nA@{ shape: imageSquare } --> B'];
  const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
  const source = ['# Delivery', ...stableDiagrams.map(item => fence(item.source)), ...rejected.map(fence), fence('flowchart LR\nCurrent --> Recovery')].join('\n\n');
  const state = await install(page, source);
  const external: string[] = [];
  await page.route('https://flowchart-resource.invalid/**', route => { external.push(route.request().url()); return route.abort(); });
  await open(page);
  const charts = page.locator('.mermaid-chart'); await expect(charts).toHaveCount(stableDiagrams.length + rejected.length + 1);
  for (const [index, fixture] of stableDiagrams.entries()) {
    const chart = charts.nth(index), image = chart.getByRole('img');
    await expect(image, fixture.name).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { message: fixture.name, timeout: 45_000 }).toBe(true);
    const svg = await image.evaluate(async (element: HTMLImageElement) => {
      const xml = new DOMParser().parseFromString(await (await fetch(element.src)).text(), 'image/svg+xml');
      return { text: xml.documentElement.textContent ?? '', viewBox: xml.documentElement.getAttribute('viewBox'), width: xml.documentElement.getAttribute('width'), height: xml.documentElement.getAttribute('height'), scripts: xml.querySelectorAll('script').length };
    });
    for (const label of fixture.labels) expect(svg.text.replace(/\s+/g, ' '), fixture.name).toContain(label);
    expect(svg.viewBox).toBeTruthy(); expect(Number(svg.width)).toBeGreaterThan(0); expect(Number(svg.height)).toBeGreaterThan(0); expect(svg.scripts).toBe(0);
  }
  const first = charts.first();
  await expect(first.locator('details')).not.toHaveAttribute('open', '');
  await first.locator('summary').click();
  await expect(first.locator('pre code')).toHaveText(stableDiagrams[0].source);
  for (const [index, expected] of rejected.entries()) {
    const chart = charts.nth(stableDiagrams.length + index);
    await expect(chart.getByRole('alert')).toBeVisible({ timeout: 45_000 });
    await expect(chart.locator('pre code')).toHaveText(expected);
    await expect(chart.getByRole('img')).toHaveCount(0);
  }
  const recovery = charts.last().getByRole('img');
  await expect(recovery).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
  const recoverySvg = await recovery.evaluate(async (element: HTMLImageElement) => (await (await fetch(element.src)).text()));
  expect(recoverySvg).toContain('Recovery');
  expect(external).toEqual([]); expect(state.writes).toEqual([]);
});

test('opening a relative attachment from graph details retains the inspected graph', async ({ page }, info) => {
  const { graph } = await install(page, description, true);
  const expected = expectedDependencyTopology(graph.tasks, taskId);
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: /^(Task chains|任务链)$/ }).click();
  await page.locator(`#task-chain-graph-${taskId}`).click();
  const body = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-body`);
  const details = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-details`);
  await body.focus(); await page.keyboard.press('Enter');
  await expect(body).toHaveAttribute('aria-pressed', 'true');
  const before = (await page.evaluate(captureStableDependencyGeometry)).geometry;
  const inspection = () => page.evaluate(() => ({
    nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => ({ id: node.dataset.id, state: node.querySelector<HTMLElement>('.task-node')!.dataset.inspection, pressed: node.querySelector('.task-node-body')!.getAttribute('aria-pressed') })).sort((a, b) => a.id!.localeCompare(b.id!)),
    edges: [...document.querySelectorAll<HTMLElement>('.task-dependency-edge')].map(edge => ({ id: edge.dataset.id, state: edge.dataset.inspection })).sort((a, b) => a.id!.localeCompare(b.id!)),
  }));
  const selected = await inspection();
  expect(await checkDependencyGeometry(page, expected, info)).toEqual({ total: 0, examples: [] });
  await details.click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.getByRole('heading', { name: 'Delivery', exact: true })).toBeVisible();
  await dialog.getByRole('link', { name: 'Read plan' }).click();
  await expect(dialog.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('.attachment-preview-pane')).toBeFocused();
  await expect(dialog.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(details).toBeFocused();
  expect(await inspection()).toEqual(selected);
  expect((await page.evaluate(captureStableDependencyGeometry)).geometry).toEqual(before);
  expect(await checkDependencyGeometry(page, expected, info)).toEqual({ total: 0, examples: [] });
});

for (const width of [1440, 320]) for (const locale of ['en', 'zh-CN']) test(`Task description card in page at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const source = `${description}\n\n- Reading item\n\n| Heading | Wide column |\n| --- | --- |\n| Value | ${'wide'.repeat(80)} |`;
  await install(page, source, false, locale);
  const check = async (surface: ReturnType<Page['locator']>) => {
    const card = surface.locator('.description-card');
    await expectDescriptionCard(page, card, width);
    await expect(card.getByRole('heading', { name: 'Delivery' })).toBeVisible();
    await expect(card.getByText('Reading item')).toBeVisible();
    if (width === 320) {
      for (const item of [card.locator('pre').first(), card.locator('.markdown-table'), card.locator('.mermaid-diagram').first()]) {
        await expect.poll(() => item.evaluate(element => element.scrollWidth > element.clientWidth), { timeout: 45_000 }).toBe(true);
      }
    }
  };
  await page.goto(`/projects/${projectId}/tasks/${taskId}`);
  const pageSurface = page.locator('.task-detail-page');
  await check(pageSurface);
  await pageSurface.getByRole('button', { name: locale === 'en' ? 'Enter fullscreen' : '进入全屏' }).click();
  await check(pageSurface);
});
