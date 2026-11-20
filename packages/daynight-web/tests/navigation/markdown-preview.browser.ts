import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { stableDiagrams } from './mermaid-stable-fixture';
import { captureStableDependencyGeometry, checkDependencyGeometry, expectedDependencyTopology } from '../helpers/dependency-geometry';
import { expectDescriptionCard } from '../helpers/description-card';
import { expectTextContrast } from './color-roles';

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
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
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

test('Markdown text follows the shared scale at different root sizes', async ({ page }) => {
  const source = '# Delivery\n\nReading [link](https://example.com) and note[^one].\n\n- List item\n\n> Quoted text\n\n`inline code`\n\n| Heading |\n| --- |\n| Cell |\n\n[^one]: Footnote';
  const state = await install(page, source);
  await open(page);
  const reader = page.locator('.task-description.markdown-content');
  for (const [rootSize, sm, xs, lg] of [[12, 10.5, 9, 13.5], [16, 14, 12, 18], [24, 21, 18, 27]]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
    for (const selector of ['p', 'li', 'blockquote', 'p > a:not([data-footnote-ref])', 'code', 'table']) {
      await expect(reader.locator(selector).first(), selector).toHaveCSS('font-size', `${sm}px`);
    }
    await expect(reader.locator('h1')).toHaveCSS('font-size', `${lg}px`);
    await expect(reader.locator('a[data-footnote-ref]')).toHaveCSS('font-size', `${xs}px`);
    await expect(reader.locator('a[data-footnote-backref]')).toHaveCSS('font-size', `${xs}px`);
  }
  expect(state.writes).toEqual([]);
});

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
  await expect(link).toHaveAttribute('href', `http://${taskId}.preview.localhost:8787${root}/preview/plan.md`); await link.click();
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

test('independent Mermaid SVG documents use measured sizes and fit their labels', async ({ page }) => {
  test.setTimeout(180_000);
  const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
  const labeledXy = (direction: string) => `xychart ${direction}\ntitle "Trend"\nx-axis [Mon, Tue, Wed]\ny-axis 0 --> 20\nline [10 "Long repeated point label Alpha", 10 "Long repeated point label Beta", 10 "Long repeated point label Gamma"]`;
  const diagrams = [...stableDiagrams, { name: 'xy-vertical', source: labeledXy('vertical') }, { name: 'xy-horizontal', source: labeledXy('horizontal') }];
  const checks: Record<string, { label?: string; selector?: string; size: 'xs' | 'sm' | 'lg' }[]> = {
    flowchart: [{ label: '开始', size: 'sm' }, { label: '完成', size: 'sm' }],
    'flowchart-elk': [{ label: 'Left', size: 'sm' }],
    sequence: [{ label: 'Sequence title', size: 'lg' }, { label: 'Web / CLI', size: 'sm' }, { label: 'DELETE Project ID', size: 'sm' }, { selector: '.sequenceNumber', size: 'xs' }],
    class: [{ label: 'Project', size: 'sm' }, { label: '包含', size: 'sm' }],
    state: [{ label: 'Ready', size: 'sm' }, { label: '确认', size: 'sm' }],
    er: [{ label: 'PROJECT', size: 'sm' }, { label: 'contains', size: 'sm' }],
    gantt: [{ label: '交付', size: 'lg' }, { label: '测试', size: 'sm' }, { selector: 'g.grid .tick text', size: 'xs' }],
    journey: [{ label: '阅读', size: 'lg' }, { label: '确认', size: 'sm' }],
    pie: [{ label: '任务状态', size: 'lg' }, { label: '待办', size: 'sm' }],
    quadrant: [{ label: '优先级', size: 'lg' }, { label: '重点', size: 'sm' }, { label: 'Low', size: 'xs' }],
    requirement: [{ label: 'PD1', size: 'sm' }],
    xy: [{ label: '趋势', size: 'lg' }, { label: 'Mon', size: 'xs' }, { label: '完成', size: 'sm' }],
    'xy-vertical': [{ label: 'Long repeated point label Alpha', size: 'sm' }, { label: 'Long repeated point label Beta', size: 'sm' }, { label: 'Long repeated point label Gamma', size: 'sm' }],
    'xy-horizontal': [{ label: 'Long repeated point label Alpha', size: 'sm' }, { label: 'Long repeated point label Beta', size: 'sm' }, { label: 'Long repeated point label Gamma', size: 'sm' }],
    block: [{ label: '客户端', size: 'sm' }],
    packet: [{ label: 'Packet title', size: 'lg' }, { label: 'A long single-bit label', size: 'sm' }, { label: '0', size: 'xs' }],
    kanban: [{ label: '待办', size: 'sm' }, { label: '检查权限', size: 'sm' }],
    eventmodeling: [{ label: 'DeleteProjectUI', size: 'sm' }],
  };
  await install(page, ['# Delivery', ...diagrams.map(item => fence(item.name === 'sequence' ? item.source.replace('sequenceDiagram', 'sequenceDiagram\ntitle Sequence title\nautonumber 999999 1') : item.name === 'packet' ? 'packet\ntitle Packet title\n0: "A long single-bit label"\n1-7: "Header"\n8-15: "Type"' : item.source))].join('\n\n'));
  await open(page);
  const charts = page.locator('.mermaid-chart');
  await expect(charts).toHaveCount(diagrams.length);
  let prior: string[] = [];
  for (const [index, fixture] of diagrams.entries()) {
    const image = charts.nth(index).getByRole('img');
    await expect(image, fixture.name).toHaveAttribute('src', /^blob:/, { timeout: 90_000 });
    prior.push((await image.getAttribute('src'))!);
  }
  for (const rootSize of [12, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
    const current: string[] = [];
    for (const [index, fixture] of diagrams.entries()) {
      const image = charts.nth(index).getByRole('img');
      await expect(image, fixture.name).toHaveAttribute('src', /^blob:/, { timeout: 90_000 });
      await expect.poll(() => image.getAttribute('src'), { message: fixture.name, timeout: 90_000 }).not.toBe(prior[index]);
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { timeout: 90_000 }).toBe(true);
      await expect.poll(() => page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, prior[index]!), { message: `${fixture.name}: old URL`, timeout: 10_000 }).toBe(false);
      const result = await image.evaluate(async (element: HTMLImageElement, requested) => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-100000px;width:1600px;height:1200px';
        document.body.append(frame);
        try {
          await new Promise<void>((resolve, reject) => { frame.onload = () => resolve(); frame.onerror = () => reject(new Error('SVG document failed to load')); frame.src = element.src; });
          const doc = frame.contentDocument!;
          const svg = doc.documentElement as unknown as SVGSVGElement;
          const box = svg.viewBox.baseVal;
          const readings = requested.map(check => {
            const candidates = check.selector ? [...doc.querySelectorAll(check.selector)] : [...doc.querySelectorAll('text, tspan, foreignObject div, foreignObject span')].filter(item => item.textContent?.trim() === check.label);
            const selected = candidates.find(item => ![...item.children].some(child => child.textContent?.trim() === check.label)) ?? candidates[0];
            if (!selected) throw new Error(`Missing label ${check.label ?? check.selector}`);
            const text = selected as SVGGraphicsElement;
            const bounds = typeof text.getBBox === 'function' ? text.getBBox() : null;
            const matrix = bounds && text.getCTM() && svg.getCTM()?.inverse().multiply(text.getCTM()!);
            const points = bounds && matrix ? [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix)) : [];
            return { size: Number.parseFloat(frame.contentWindow!.getComputedStyle(selected).fontSize), expected: check.size, label: check.label ?? check.selector, bounds: bounds && { width: bounds.width, height: bounds.height }, inside: points.every(point => point.x >= box.x - 1 && point.y >= box.y - 1 && point.x <= box.x + box.width + 1 && point.y <= box.y + box.height + 1) };
          });
          const packetBlocks = [...doc.querySelectorAll('rect.packetBlock')].map((rect, index) => {
            const label = doc.querySelectorAll<SVGGraphicsElement>('text.packetLabel')[index];
            const a = (rect as SVGGraphicsElement).getBBox(), b = label?.getBBox();
            return b !== undefined && b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
          });
          const circle = doc.querySelector<SVGGraphicsElement>('marker[id$="-sequencenumber"] circle');
          const radius = circle ? circle.getBBox().width / 2 : 0;
          const lines = [...doc.querySelectorAll<SVGLineElement>('line[marker-start$="-sequencenumber)"]')];
          const centers = lines.map(line => ({ x: line.x1.baseVal.value, y: line.y1.baseVal.value }));
          const numbers = [...doc.querySelectorAll<SVGGraphicsElement>('text.sequenceNumber')].map((number, index) => {
            const bounds = number.getBBox(), matrix = svg.getCTM()!.inverse().multiply(number.getCTM()!);
            const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
            const center = centers[index];
            return center !== undefined && corners.every(point => Math.hypot(point.x - center.x, point.y - center.y) <= radius + 1);
          });
          const separated = centers.every((center, index) => index === 0 || Math.hypot(center.x - centers[index - 1]!.x, center.y - centers[index - 1]!.y) >= radius * 2);
          const xyLabels = [...doc.querySelectorAll<SVGGraphicsElement>('.plot .line-plot-0 .labels text')].map(text => {
            const rect = text.getBBox(), matrix = svg.getCTM()!.inverse().multiply(text.getCTM()!);
            const a = new DOMPoint(rect.x, rect.y).matrixTransform(matrix), b = new DOMPoint(rect.x + rect.width, rect.y + rect.height).matrixTransform(matrix);
            return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
          });
          const xySeparated = xyLabels.every((a, i) => xyLabels.slice(i + 1).every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
          return { src: element.src, viewBox: svg.getAttribute('viewBox'), readings, packetBlocks, radius, numbers, separated, xyLabels: xyLabels.length, xySeparated };
        } finally { frame.remove(); }
      }, checks[fixture.name]!);
      expect(result.viewBox, fixture.name).toBeTruthy();
      for (const reading of result.readings) {
        const label = `${fixture.name}: ${reading.label}`;
        expect.soft(reading.size, label).toBeCloseTo(rootSize * ({ xs: 0.75, sm: 0.875, lg: 1.125 }[reading.expected]), 2);
        if (reading.bounds) { expect.soft(reading.bounds.width, label).toBeGreaterThan(0); expect.soft(reading.bounds.height, label).toBeGreaterThan(0); expect.soft(reading.inside, label).toBe(true); }
      }
      if (fixture.name === 'packet') { expect(result.packetBlocks.length).toBeGreaterThan(0); expect(result.packetBlocks.every(Boolean)).toBe(true); }
      if (fixture.name === 'sequence') { expect(result.radius).toBeGreaterThan(0); expect(result.numbers.length).toBeGreaterThan(1); expect(result.numbers.every(Boolean)).toBe(true); expect(result.separated).toBe(true); }
      if (fixture.name.startsWith('xy-')) { expect(result.xyLabels).toBe(3); expect(result.xySeparated).toBe(true); }
      current.push(result.src);
    }
    prior = current;
  }
});

test('Mermaid source styles retain priority over default diagram sizes', async ({ page }) => {
  await install(page, '# Delivery\n\n```mermaid\nflowchart TD\nA[Custom]:::large\nclassDef large font-size:30px\n```');
  await open(page);
  const image = page.locator('.mermaid-chart').getByRole('img');
  await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
  const size = await image.evaluate(async (element: HTMLImageElement) => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    try {
      await new Promise<void>((resolve, reject) => { frame.onload = () => resolve(); frame.onerror = () => reject(new Error('SVG failed to load')); frame.src = element.src; });
      const label = [...frame.contentDocument!.querySelectorAll('text, tspan')].find(item => item.textContent?.trim() === 'Custom' && item.children.length === 0);
      if (!label) throw new Error('Missing styled label');
      return frame.contentWindow!.getComputedStyle(label).fontSize;
    } finally { frame.remove(); }
  });
  expect(size).toBe('30px');
});

test('dense XY point labels remain readable as the root size changes', async ({ page }) => {
  const categories = Array.from({ length: 30 }, (_, index) => `D${index + 1}`);
  const points = categories.map((_, index) => `10 "Daynight labeled data point ${index + 1}"`);
  await install(page, `# Delivery\n\n\`\`\`mermaid\nxychart\nx-axis [${categories.join(', ')}]\ny-axis 0 --> 20\nline [${points.join(', ')}]\n\`\`\``);
  await open(page);
  const image = page.locator('.mermaid-chart').getByRole('img');
  await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
  for (const rootSize of [12, 24]) {
    const previous = await image.getAttribute('src');
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
    await expect.poll(() => image.getAttribute('src'), { timeout: 45_000 }).not.toBe(previous);
    const result = await image.evaluate(async (element: HTMLImageElement) => {
      const frame = document.createElement('iframe'); document.body.append(frame);
      try {
        await new Promise<void>((resolve, reject) => { frame.onload = () => resolve(); frame.onerror = () => reject(new Error('SVG failed to load')); frame.src = element.src; });
        const svg = frame.contentDocument!.documentElement as unknown as SVGSVGElement;
        const box = svg.viewBox.baseVal;
        const labels = [...frame.contentDocument!.querySelectorAll<SVGGraphicsElement>('.plot .line-plot-0 .labels text')].map(text => {
          const b = text.getBBox(), matrix = svg.getCTM()!.inverse().multiply(text.getCTM()!);
          const a = new DOMPoint(b.x, b.y).matrixTransform(matrix), z = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(matrix);
          return { left: Math.min(a.x, z.x), right: Math.max(a.x, z.x), top: Math.min(a.y, z.y), bottom: Math.max(a.y, z.y), size: parseFloat(frame.contentWindow!.getComputedStyle(text).fontSize) };
        });
        return { labels, view: { x: box.x, y: box.y, width: box.width, height: box.height } };
      } finally { frame.remove(); }
    });
    expect(result.labels).toHaveLength(30);
    for (const [index, label] of result.labels.entries()) {
      expect.soft(label.size).toBeCloseTo(rootSize * 0.875, 2);
      expect.soft(label.left >= result.view.x && label.right <= result.view.x + result.view.width && label.top >= result.view.y && label.bottom <= result.view.y + result.view.height).toBe(true);
      expect.soft(result.labels.slice(index + 1).every(other => label.right <= other.left || other.right <= label.left || label.bottom <= other.top || other.bottom <= label.top)).toBe(true);
    }
  }
});

test('overlapping XY series keep their labels and wrap long text', async ({ page }) => {
  const longLabel = 'Wide label '.repeat(60).trim();
  await install(page, `# Delivery\n\n\`\`\`mermaid\nxychart\nx-axis [Only]\ny-axis 0 --> 20\nline [10 "${longLabel}"]\nline [10 "Second series"]\n\`\`\``);
  await open(page);
  const image = page.locator('.mermaid-chart').getByRole('img');
  await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
  const prior = await image.getAttribute('src');
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await expect.poll(() => image.getAttribute('src'), { timeout: 45_000 }).not.toBe(prior);
  const result = await image.evaluate(async (element: HTMLImageElement) => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    try {
      await new Promise<void>((resolve, reject) => { frame.onload = () => resolve(); frame.onerror = () => reject(new Error('SVG failed to load')); frame.src = element.src; });
      const doc = frame.contentDocument!, svg = doc.documentElement as unknown as SVGSVGElement;
      const labels = [...doc.querySelectorAll<SVGGraphicsElement>('.plot .labels text')].map(text => {
        const bounds = text.getBBox(), matrix = svg.getCTM()!.inverse().multiply(text.getCTM()!);
        const a = new DOMPoint(bounds.x, bounds.y).matrixTransform(matrix), b = new DOMPoint(bounds.x + bounds.width, bounds.y + bounds.height).matrixTransform(matrix);
        return { text: text.textContent, lines: text.querySelectorAll('tspan').length, left: a.x, right: b.x, top: a.y, bottom: b.y };
      });
      return { labels, guides: doc.querySelectorAll('.label-guides path').length };
    } finally { frame.remove(); }
  });
  expect(result.labels).toHaveLength(2);
  expect(result.labels[0]?.text).toBe(longLabel);
  expect(result.labels[0]!.lines).toBeGreaterThan(1);
  expect(result.labels[1]?.text).toBe('Second series');
  const [a, b] = result.labels;
  expect(a!.right <= b!.left || b!.right <= a!.left || a!.bottom <= b!.top || b!.bottom <= a!.top).toBe(true);
  expect(result.guides).toBeGreaterThan(0);
});

test('displaced XY labels paint over their background', async ({ page }) => {
  await install(page, '# Delivery\n\n```mermaid\nxychart\nx-axis [Only]\ny-axis 0 --> 20\nline [10 "First label"]\nline [10 "Second label"]\n```');
  await open(page);
  const image = page.locator('.mermaid-chart').getByRole('img');
  await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  const changed = await image.evaluate(async (element: HTMLImageElement) => {
    const bytes = await (await fetch(element.src)).text();
    const xml = new DOMParser().parseFromString(bytes, 'image/svg+xml');
    const label = xml.querySelector('.plot .line-plot-1 .labels text');
    if (!label || label.textContent !== 'Second label') throw new Error('Missing displaced series label');
    label.setAttribute('visibility', 'hidden');
    const raster = async (svg: string) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      try {
        const picture = new Image(); picture.src = url; await picture.decode();
        const canvas = new OffscreenCanvas(picture.naturalWidth, picture.naturalHeight), context = canvas.getContext('2d')!;
        context.drawImage(picture, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      } finally { URL.revokeObjectURL(url); }
    };
    const original = await raster(bytes), hidden = await raster(new XMLSerializer().serializeToString(xml));
    let pixels = 0;
    for (let i = 0; i < original.length; i += 4) if (Math.abs(original[i]! - hidden[i]!) + Math.abs(original[i + 1]! - hidden[i + 1]!) + Math.abs(original[i + 2]! - hidden[i + 2]!) > 30) pixels++;
    return pixels;
  });
  expect(changed).toBeGreaterThan(20);
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
  const source = `${description}\n\n- Reading item\n\n| Heading | Wide column |\n| --- | --- |\n| Value | ${'wide'.repeat(80)} |\n\nNote[^one]\n\n[^one]: A footnote`;
  await install(page, source, false, locale);
  const check = async (surface: ReturnType<Page['locator']>) => {
    const card = surface.locator('.description-card');
    await expectDescriptionCard(page, card, width);
    await expect(card.getByRole('heading', { name: 'Delivery' })).toBeVisible();
    await expect(card.getByText('Reading item')).toBeVisible();
    const code = card.getByRole('region', { name: locale === 'en' ? 'Code' : '代码', exact: true });
    const table = card.getByRole('region', { name: locale === 'en' ? 'Table' : '表格', exact: true });
    const diagram = card.getByRole('region', { name: locale === 'en' ? 'Diagram' : '图表', exact: true }).first();
    await expect(code).toHaveAttribute('tabindex', '0');
    await expect(table).toHaveAttribute('tabindex', '0');
    await expect(diagram).toHaveAttribute('tabindex', '0');
    await expect(card.locator('.footnotes h2')).toHaveText(locale === 'en' ? 'Footnotes' : '脚注');
    await expect(card.locator('a[data-footnote-backref]')).toHaveAttribute('aria-label', locale === 'en' ? 'Back to reference' : '返回引用');
    if (width === 320) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const item of [code, table, diagram]) {
        await expect.poll(() => item.evaluate(element => element.scrollWidth > element.clientWidth), { timeout: 45_000 }).toBe(true);
        await item.focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => item.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      }
    }
  };
  await page.goto(`/projects/${projectId}/tasks/${taskId}`);
  const pageSurface = page.locator('.task-detail-page');
  await check(pageSurface);
  await pageSurface.getByRole('button', { name: locale === 'en' ? 'Enter fullscreen' : '进入全屏' }).click();
  await check(pageSurface);
});

for (const width of [1440, 320]) for (const locale of ['en', 'zh-CN']) test(`Task attachment image retry preserves reading at ${width}px in ${locale}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 800 });
  const imagePath = `${root}/preview/images/failed%20image.svg`;
  const imageUrl = `http://${taskId}.preview.localhost:8787${imagePath}?variant=one%2Ftwo&size=2#drawing`;
  const source = `# Delivery\n\n${'Earlier reading paragraph.\n\n'.repeat(30)}## Image recovery anchor\n\n![${'Long attachment image name '.repeat(15)}](images/failed%20image.svg?variant=one%2Ftwo&size=2#drawing)\n\n![Loaded sibling](images/loaded.svg)\n\n![External image](https://external-image.invalid/failed.svg)\n\n![Native image](/native-image.svg)\n\n${'A paragraph retained around the failed image.\n\n'.repeat(60)}`;
  const state = await install(page, source, false, locale);
  const requests: string[] = [];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#256a48"/></svg>';
  const retryGate = Promise.withResolvers<void>();
  await page.route('**/preview/images/**', async route => {
    requests.push(route.request().url());
    const target = new URL(route.request().url()).pathname === imagePath;
    const attempt = requests.filter(value => new URL(value).pathname === imagePath).length;
    if (target && attempt > 1) await retryGate.promise;
    return target && attempt === 1
      ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not_found"}}' })
      : route.fulfill({ contentType: 'image/svg+xml', body: svg });
  });
  const native: string[] = [];
  await page.route('https://external-image.invalid/**', route => { native.push(route.request().url()); return route.abort('failed'); });
  await page.route('**/native-image.svg', route => { native.push(route.request().url()); return route.fulfill({ contentType: 'image/svg+xml', body: svg }); });
  await open(page);
  const reader = page.locator('.task-description');
  const error = reader.getByRole('alert');
  await expect(error).toHaveCount(1);
  await expect(error).toContainText(locale === 'en' ? 'Unable to load the attachment image' : '无法加载附件图片');
  await expectTextContrast(error);
  const retry = error.getByRole('button', { name: locale === 'en' ? 'Retry image' : '重试图片', exact: true });
  await expect(retry).toBeVisible();
  await expect(reader.getByRole('img', { name: 'External image', exact: true })).toHaveAttribute('src', 'https://external-image.invalid/failed.svg');
  await expect(reader.getByRole('img', { name: 'Native image', exact: true })).toHaveAttribute('src', '/native-image.svg');
  const sibling = reader.getByRole('img', { name: 'Loaded sibling', exact: true });
  await expect.poll(() => sibling.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
  const siblingHandle = await sibling.elementHandle();
  const before = [...requests], nativeBefore = [...native];
  const readerHandle = await reader.elementHandle();
  await retry.scrollIntoViewIfNeeded();
  const readingPosition = () => reader.getByRole('heading', { name: 'Image recovery anchor', exact: true }).evaluate(element => {
    let owner = element.parentElement!;
    while (owner.parentElement && !(owner.scrollHeight > owner.clientHeight && /auto|scroll/.test(getComputedStyle(owner).overflowY))) owner = owner.parentElement;
    return { top: owner.scrollTop, anchor: element.getBoundingClientRect().top };
  });
  const position = await readingPosition();
  expect(position.top).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('attachment-image-failure.png') });
  try {
    await retry.click();
    await expect.poll(() => requests.length).toBe(before.length + 1);
    await expect(error).toHaveCount(0);
    expect(await readingPosition()).toEqual(position);
  } finally { retryGate.resolve(); }
  const recovered = reader.locator(`img[src="${imageUrl}"]`);
  await expect.poll(() => recovered.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
  expect(await readingPosition()).toEqual(position);
  expect(requests.slice(before.length)).toEqual([imageUrl.split('#')[0]]);
  expect(native).toEqual(nativeBefore);
  expect(await siblingHandle!.evaluate(element => element.isConnected)).toBe(true);
  expect(await readerHandle!.evaluate(element => element.isConnected)).toBe(true);
  expect(state.writes).toEqual([]);
  await siblingHandle!.dispose(); await readerHandle!.dispose();
});
