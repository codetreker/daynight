import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { hasPaintedPdfMarker, readPdfPixels } from '../helpers/pdf-pixels';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const successorId = '00000000-0000-4000-8000-000000000042';
const personalId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const root = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const longPath = Array.from({ length: 4 }, (_, i) => { const prefix = `z${i}-`, suffix = i === 3 ? '-path-tail-visible.txt' : ''; return `${prefix}${'x'.repeat(180 - prefix.length - suffix.length)}${suffix}`; }).join('/');
const longText = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: browser reading and text selection`).join('\n');
const markdown = '# Reading notes\n\nA **real** Markdown preview.\n\n![Fixture vector](icon.svg)\n\n[Vector file](icon.svg)';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#11cb95"/></svg>';
const pdf = readFileSync(new URL('./fixtures/brief.pdf', import.meta.url));
const readingPdf = readFileSync(new URL('./fixtures/reading.pdf', import.meta.url));
const html = '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script defer src="app.js"></script></head><body style="height:2000px"><button id="counter">0</button><p id="data"></p><img src="icon.svg" alt="Relative image"></body></html>';
const script = `document.querySelector('#counter').addEventListener('click', event => { event.target.textContent = String(Number(event.target.textContent) + 1); }); fetch('data.json').then(response => response.json()).then(data => { document.querySelector('#data').textContent = data.label; });`;
const files = [
  { path: 'reading.txt', contentType: 'text/plain', sizeBytes: longText.length, createdAt: time, updatedAt: time },
  { path: 'interactive.html', contentType: 'text/html', sizeBytes: html.length, createdAt: time, updatedAt: time },
  { path: 'brief.pdf', contentType: 'application/pdf', sizeBytes: pdf.length, createdAt: time, updatedAt: time },
  { path: 'reading.pdf', contentType: 'application/pdf', sizeBytes: readingPdf.length, createdAt: time, updatedAt: time },
  { path: 'reading.md', contentType: 'text/markdown', sizeBytes: markdown.length, createdAt: time, updatedAt: time },
  { path: 'icon.svg', contentType: 'image/svg+xml', sizeBytes: svg.length, createdAt: time, updatedAt: time },
  { path: longPath, contentType: 'text/plain', sizeBytes: 4, createdAt: time, updatedAt: time },
];

async function install(page: Page, linked = false) {
  const task = detailFixture(projectId, taskId, { title: 'Attachment reading', version: 5n });
  const successor = detailFixture(projectId, successorId, { title: 'Linked successor', version: 5n, dependsOn: [taskId], blockedBy: [taskId], ready: false });
  const graph = graphFixture(linked ? [task, successor] : [task]);
  const state = { writes: [] as string[], resources: [] as string[], identityReads: 0, holdIdentity: null as Promise<void> | null };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') {
      state.identityReads++;
      if (state.holdIdentity) await state.holdIdentity;
      return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    }
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    if (path === root) return send(task);
    if (linked && path === `/api/v1/projects/${projectId}/tasks/${successorId}`) return send(successor);
    if (linked && path === `/api/v1/projects/${projectId}/tasks/${successorId}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${root}/attachments`) return send({ items: files, nextCursor: null });
    if (path === `${root}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${root}/attachments/files/reading.md`) return route.fulfill({ body: markdown, headers: { 'Content-Type': 'text/markdown', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path.startsWith(`${root}/preview/`)) state.resources.push(path);
    if (path === `${root}/preview/style.css`) return route.fulfill({ body: 'body { background: rgb(246, 247, 252) }', headers: { 'Content-Type': 'text/css' } });
    if (path === `${root}/preview/app.js`) return route.fulfill({ body: script, headers: { 'Content-Type': 'text/javascript' } });
    if (path === `${root}/preview/data.json`) return route.fulfill({ body: JSON.stringify({ label: 'Relative JSON loaded' }), headers: { 'Content-Type': 'application/json' } });
    if (path === `${root}/preview/icon.svg`) return route.fulfill({ body: svg, headers: { 'Content-Type': 'image/svg+xml', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/attachments/files/reading.txt`) return route.fulfill({ body: longText, headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/preview/reading.pdf`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : readingPdf, headers: { 'Content-Type': 'application/pdf', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/preview/brief.pdf`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : pdf, headers: { 'Content-Type': 'application/pdf', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/preview/interactive.html`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : html, headers: { 'Content-Type': 'text/html', 'Daynight-User-ID': TEST_VIEWER_ID } });
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}

async function openDialog(page: Page) {
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
  const trigger = page.locator(`#standalone-task-${taskId}`);
  await trigger.click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog).toHaveAccessibleName('Attachment reading');
  await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  return { trigger, dialog, attachments: dialog.locator('.task-attachments') };
}

for (const viewport of [{ width: 1440, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) {
  test(`embedded attachment preview owns reading scroll at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await install(page);
    const before = await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }));
    const { trigger, dialog, attachments } = await openDialog(page);
    await attachments.getByRole('button', { name: /^reading\.txt/ }).click();
    const body = attachments.locator('.attachment-preview-body');
    await expect(body.locator('pre')).toHaveText(longText);
    const panes = await attachments.locator('.attachment-sidebar,.attachment-preview-pane').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
    }));
    expect(panes).toHaveLength(2);
    expect(panes[0]!.right).toBeLessThanOrEqual(panes[1]!.left + 1);
    expect(Math.abs(panes[0]!.top - panes[1]!.top)).toBeLessThanOrEqual(1);
    expect(panes[1]!.height).toBeGreaterThan(80);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(attachments.getByRole('link', { name: 'Download', exact: true })).toBeInViewport({ ratio: 1 });
    const scroll = await body.evaluate(element => {
      const chain = [];
      for (let node: Element | null = element; node && !node.classList.contains('task-detail-backdrop'); node = node.parentElement) chain.push({ height: node.clientHeight, scrollHeight: node.scrollHeight });
      return chain;
    });
    expect(scroll[0]!.scrollHeight).toBeGreaterThan(scroll[0]!.height);
    expect(scroll.slice(1).filter(entry => entry.scrollHeight > entry.height + 1)).toEqual([]);
    await body.focus(); await page.keyboard.press('PageDown');
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await dialog.getByRole('button', { name: 'Close task details', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }))).toEqual(before);
    expect(state.writes).toEqual([]);
  });
}

test('native HTML preview preserves frame ownership and returns focus after Escape', async ({ page }) => {
  const state = await install(page);
  const { trigger, dialog, attachments } = await openDialog(page);
  await attachments.getByRole('button', { name: /^interactive\.html/ }).click();
  const frame = attachments.locator('iframe');
  await expect(frame).toBeInViewport({ ratio: 1 });
  const counter = frame.contentFrame().locator('#counter');
  await counter.click(); await expect(counter).toHaveText('1');
  await expect(frame.contentFrame().locator('#data')).toHaveText('Relative JSON loaded');
  await expect.poll(() => frame.contentFrame().getByRole('img', { name: 'Relative image' }).evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
  expect(await frame.contentFrame().locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(246, 247, 252)');
  for (const resource of ['style.css', 'app.js', 'data.json', 'icon.svg']) expect(state.resources).toContain(`${root}/preview/${resource}`);
  expect(await counter.evaluate(element => element.ownerDocument.documentElement.scrollHeight > element.ownerDocument.documentElement.clientHeight)).toBe(true);
  const body = attachments.locator('.attachment-preview-body');
  expect(await body.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  const frameHandle = await frame.elementHandle();
  const disclosure = attachments.locator('.attachment-upload-disclosure');
  await disclosure.locator('summary').click();
  const input = attachments.locator('input[type=file]');
  await input.setInputFiles({ name: 'unsent.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsent draft') });
  const inputHandle = await input.elementHandle();
  await attachments.getByRole('textbox', { name: 'Target relative path' }).fill('drafts/unsent.txt');
  await disclosure.locator('summary').click();
  const reads = state.resources.filter(path => path.endsWith('/interactive.html')).length;
  await frame.contentFrame().locator('html').evaluate(element => { element.scrollTop = 500; });
  const scroll = await frame.contentFrame().locator('html').evaluate(element => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await dialog.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(dialog.locator('.task-detail-panel-attachments')).toHaveAttribute('inert', '');
  await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
  expect(await inputHandle!.evaluate(element => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
  await expect(counter).toHaveText('1');
  expect(await frame.contentFrame().locator('html').evaluate(element => element.scrollTop)).toBe(scroll);
  await disclosure.locator('summary').click();
  await expect(attachments.getByRole('textbox', { name: 'Target relative path' })).toHaveValue('drafts/unsent.txt');
  expect(await input.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe('unsent.txt');
  await dialog.locator('.task-detail-fullscreen-toggle').click();
  await expect(dialog).toHaveClass(/task-detail-fullscreen/);
  await expect(counter).toHaveText('1');
  expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
  await counter.press('Escape');
  await expect(dialog).not.toHaveClass(/task-detail-fullscreen/);
  await expect(counter).toHaveText('1');
  expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
  expect(state.resources.filter(path => path.endsWith('/interactive.html')).length).toBe(reads);
  await counter.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await frameHandle!.dispose(); await inputHandle!.dispose();
  expect(state.writes).toEqual([]);
});

test('a pending same-account check preserves actual text selection and preview scroll', async ({ page }) => {
  const state = await install(page);
  const { dialog, attachments } = await openDialog(page);
  await attachments.getByRole('button', { name: /^reading\.txt/ }).click();
  const body = attachments.locator('.attachment-preview-body');
  const pre = body.locator('pre'); await expect(pre).toHaveText(longText);
  await body.evaluate(element => { element.scrollTop = 300; });
  const top = await body.evaluate(element => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await pre.evaluate(element => {
    const text = element.firstChild!; const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Line 1');
  const gate = Promise.withResolvers<void>(); state.holdIdentity = gate.promise;
  const reads = state.identityReads;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    window.dispatchEvent(new Event('blur')); Reflect.deleteProperty(document, 'hasFocus');
    window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));
  });
  try {
    await expect.poll(() => state.identityReads).toBeGreaterThan(reads);
    await expect(dialog).toBeVisible(); await expect(pre).toHaveText(longText);
    expect(await body.evaluate(element => element.scrollTop)).toBe(top);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Line 1');
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me');
    state.holdIdentity = null; gate.resolve(); await completed;
    await expect(pre).toHaveText(longText);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Line 1');
    expect(await body.evaluate(element => element.scrollTop)).toBe(top);
    expect(state.writes).toEqual([]);
  } finally { gate.resolve(); }
});

// The colored rectangle is part of the small source PDF. Checking its actual
// pixels distinguishes a rendered page from an iframe that merely loaded.
test('native PDF preview paints its document in the browser', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await install(page);
  const { attachments } = await openDialog(page);
  await attachments.getByRole('button', { name: /^brief\.pdf/ }).click();
  const frame = attachments.locator('iframe');
  await expect(frame).toBeVisible();
  await expect.poll(async () => {
    const png = await frame.screenshot({ animations: 'disabled' });
    return hasPaintedPdfMarker(await page.evaluate(readPdfPixels, png.toString('base64')));
  }, { message: 'PDF preview paints the fixture rectangle', timeout: 20_000, intervals: [100, 250, 500] }).toBe(true);
});

for (const viewport of [{ width: 1440, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) {
  test(`standalone Markdown and image previews render at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await install(page);
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/reading.md`);
    const attachments = page.locator('.task-attachments');
    await expect(attachments.getByRole('heading', { name: 'reading.md', exact: true })).toBeVisible();
    await expect(attachments.getByRole('heading', { name: 'Reading notes', exact: true })).toBeVisible();
    await expect(attachments.locator('strong')).toHaveText('real');
    const image = attachments.getByRole('img', { name: 'Fixture vector' });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
    await expect(attachments.getByRole('link', { name: 'Vector file' })).toHaveAttribute('href', `${root}/preview/icon.svg`);
    await expect(attachments.getByRole('link', { name: 'Download', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const panes = await attachments.locator('.attachment-sidebar,.attachment-preview-pane').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
    }));
    expect(panes).toHaveLength(2); expect(panes[0]!.right).toBeLessThanOrEqual(panes[1]!.left + 1);
    expect(Math.abs(panes[0]!.top - panes[1]!.top)).toBeLessThanOrEqual(1); expect(panes[1]!.height).toBeGreaterThan(80);
    await attachments.getByRole('button', { name: /^icon\.svg/ }).click();
    const directImage = attachments.getByRole('img', { name: 'icon.svg' });
    await expect.poll(() => directImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/attachments/icon\\.svg$`));
    await page.reload();
    await expect.poll(() => directImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
    expect(state.writes).toEqual([]);
  });
}

test('multi-page PDF accepts native wheel and keyboard scrolling to its final painted page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await install(page); const { attachments } = await openDialog(page);
  await attachments.getByRole('button', { name: /^reading\.pdf/ }).click();
  const frame = attachments.locator('iframe'); await expect(frame).toBeVisible();
  const count = async (rgb: number[]) => {
    const png = await frame.screenshot({ animations: 'disabled' });
    return page.evaluate(async ({ base64, rgb }) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0); bitmap.close(); const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let matches = 0; for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i]! - rgb[0]!) < 4 && Math.abs(data[i + 1]! - rgb[1]!) < 4 && Math.abs(data[i + 2]! - rgb[2]!) < 4) matches++;
      return matches;
    }, { base64: png.toString('base64'), rgb });
  };
  await expect.poll(() => count([26, 204, 179]), { timeout: 20_000 }).toBeGreaterThan(1000);
  const bounds = (await frame.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => count([102, 204, 128]), { timeout: 10_000 }).toBeGreaterThan(1000);
  await frame.focus(); await page.keyboard.press('End');
  await expect.poll(() => count([179, 204, 77]), { timeout: 10_000 }).toBeGreaterThan(1000);
});

test('standalone loaded HTML retains its frame and draft through fullscreen owner installation and release', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/interactive.html`);
  const surface = page.locator('.task-detail-page');
  const attachments = surface.locator('.task-attachments');
  const frame = attachments.locator('iframe'), counter = frame.contentFrame().locator('#counter');
  await counter.click(); await expect(counter).toHaveText('1');
  const frameHandle = await frame.elementHandle();
  const disclosure = attachments.locator('.attachment-upload-disclosure'); await disclosure.locator('summary').click();
  const input = attachments.locator('input[type=file]');
  await input.setInputFiles({ name: 'reader.txt', mimeType: 'text/plain', buffer: Buffer.from('draft') });
  const inputHandle = await input.elementHandle();
  await attachments.getByRole('textbox', { name: 'Target relative path' }).fill('drafts/reader.txt');
  const reads = state.resources.filter(path => path.endsWith('/interactive.html')).length;
  await surface.locator('.task-detail-fullscreen-toggle').click();
  await expect(surface).toHaveClass(/task-detail-fullscreen/);
  await counter.press('Escape');
  await expect(surface).not.toHaveClass(/task-detail-fullscreen/);
  await counter.press('Escape');
  await expect(surface).toBeVisible(); await expect(counter).toHaveText('1');
  expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
  expect(await inputHandle!.evaluate(element => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
  expect(await input.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe('reader.txt');
  await expect(attachments.getByRole('textbox', { name: 'Target relative path' })).toHaveValue('drafts/reader.txt');
  expect(state.resources.filter(path => path.endsWith('/interactive.html')).length).toBe(reads);
  await frameHandle!.dispose(); await inputHandle!.dispose(); expect(state.writes).toEqual([]);
});

test('standalone relation navigation and foreground verification preserve the current HTML reader', async ({ page }) => {
  const state = await install(page, true);
  const original = `/projects/${projectId}/tasks/${taskId}/attachments/interactive.html`;
  await page.goto(original);
  const surface = page.locator('.task-detail-page'), attachments = surface.locator('.task-attachments');
  await expect(attachments.locator('iframe').contentFrame().locator('#counter')).toHaveText('0');
  await surface.getByRole('tab', { name: 'Overview', exact: true }).click();
  await surface.locator('.task-detail-relation').filter({ hasText: 'Linked successor' }).click();
  await expect(surface.locator('.task-detail-title')).toHaveText('Linked successor');
  await page.goBack();
  await expect(surface.locator('.task-detail-title')).toHaveText('Attachment reading');
  await surface.getByRole('tab', { name: 'Attachments', exact: true }).click();
  const frame = attachments.locator('iframe'), counter = frame.contentFrame().locator('#counter');
  await counter.click(); await expect(counter).toHaveText('1');
  const handle = await frame.elementHandle();
  const html = frame.contentFrame().locator('html');
  await html.evaluate(element => { element.scrollTop = 500; });
  const top = await html.evaluate(element => element.scrollTop); expect(top).toBeGreaterThan(0);
  const reads = state.resources.filter(path => path.endsWith('/interactive.html')).length;
  const gate = Promise.withResolvers<void>(); state.holdIdentity = gate.promise; const identityReads = state.identityReads;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    window.dispatchEvent(new Event('blur')); Reflect.deleteProperty(document, 'hasFocus');
    window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));
  });
  try {
    await expect.poll(() => state.identityReads).toBeGreaterThan(identityReads);
    expect(await handle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    await expect(counter).toHaveText('1'); expect(await html.evaluate(element => element.scrollTop)).toBe(top);
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me');
    state.holdIdentity = null; gate.resolve(); await completed;
    await expect(counter).toHaveText('1'); expect(await html.evaluate(element => element.scrollTop)).toBe(top);
    expect(state.resources.filter(path => path.endsWith('/interactive.html')).length).toBe(reads);
  } finally { gate.resolve(); }
  await handle!.dispose(); expect(state.writes).toEqual([]);
});

test('standalone native HTML and PDF fit the reader and PDF exits through the page control', async ({ page }) => {
  const state = await install(page);
  for (const viewport of [{ width: 1440, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/interactive.html`);
    const attachments = page.locator('.task-attachments'), frame = attachments.locator('iframe'), body = attachments.locator('.attachment-preview-body');
    await expect(frame.contentFrame().locator('#data')).toHaveText('Relative JSON loaded');
    await expect(attachments.getByRole('link', { name: 'Download', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(frame).toBeInViewport({ ratio: 1 });
    expect((await frame.boundingBox())!.height).toBeCloseTo((await body.boundingBox())!.height, 0);
    expect(await body.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/brief.pdf`);
  const frame = page.locator('.task-attachments iframe');
  await expect.poll(async () => { const png = await frame.screenshot({ animations: 'disabled' }); return hasPaintedPdfMarker(await page.evaluate(readPdfPixels, png.toString('base64'))); }, { timeout: 20_000 }).toBe(true);
  await page.getByRole('link', { name: 'Return to task project', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
  test(`long attachment deletion remains readable and cancellable at ${viewport.width}x${viewport.height} in ${locale}`, async ({ page }) => {
    const state = await install(page); await page.setViewportSize(viewport);
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/reading.md`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const attachments = page.locator('.task-attachments');
    const parts = longPath.split('/');
    for (const part of parts.slice(0, -1)) await attachments.locator('summary').filter({ hasText: part }).click();
    await attachments.getByLabel(locale === 'en' ? `More actions: ${longPath}` : `更多操作：${longPath}`).click();
    await page.getByRole('menuitem', { name: locale === 'en' ? 'Delete' : '删除', exact: true }).click();
    const dialog = page.locator('.attachment-delete-dialog'), body = dialog.locator('.attachment-delete-body');
    const cancel = dialog.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true });
    const confirm = dialog.getByRole('button', { name: locale === 'en' ? 'Delete attachment' : '删除附件', exact: true });
    await expect(dialog).toContainText(longPath); await expect(dialog).toBeInViewport({ ratio: 1 }); await expect(cancel).toBeFocused();
    for (const element of [dialog.locator('header'), dialog.locator('footer'), cancel, confirm]) await expect(element).toBeInViewport({ ratio: 1 });
    const metrics = await dialog.evaluate(element => { const body = element.querySelector<HTMLElement>('.attachment-delete-body')!; return { dh: element.clientHeight, ds: element.scrollHeight, bh: body.clientHeight, bs: body.scrollHeight, overflow: getComputedStyle(body).overflowY }; });
    expect(metrics.ds).toBeLessThanOrEqual(metrics.dh + 1); expect(metrics.overflow).toMatch(/^(auto|scroll)$/); expect(metrics.bs).toBeGreaterThan(metrics.bh);
    const pathEdge = (edge: 'start' | 'end') => dialog.locator('.attachment-delete-path').evaluate((element, edge) => {
      const text = element.firstChild!, range = document.createRange(), length = text.textContent!.length;
      range.setStart(text, edge === 'start' ? 0 : length - 24); range.setEnd(text, edge === 'start' ? 24 : length);
      const rect = range.getBoundingClientRect(), container = element.closest('.attachment-delete-body')!.getBoundingClientRect();
      return rect.top >= container.top - 1 && rect.bottom <= container.bottom + 1 && rect.left >= container.left - 1 && rect.right <= container.right + 1;
    }, edge);
    await expect.poll(() => pathEdge('start')).toBe(true);
    const bounds = (await body.boundingBox())!; await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(0, metrics.bs);
    await expect.poll(() => pathEdge('end')).toBe(true);
    await cancel.focus(); await page.keyboard.press('Shift+Tab'); await expect(body).toBeFocused();
    await page.keyboard.press('Home'); await expect.poll(() => pathEdge('start')).toBe(true);
    await page.keyboard.press('End'); await expect.poll(() => pathEdge('end')).toBe(true);
    await page.keyboard.press('Tab'); await expect(cancel).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(body).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(confirm).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await cancel.click(); await expect(dialog).toHaveCount(0); expect(state.writes).toEqual([]);
  });
}
