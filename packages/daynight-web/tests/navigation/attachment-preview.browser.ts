import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { hasPaintedPdfMarker, readPdfPixels } from '../helpers/pdf-pixels';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
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
  { path: 'acceptance-evidence.json', contentType: 'application/json', sizeBytes: 19916, createdAt: time, updatedAt: time },
  { path: 'reading.txt', contentType: 'text/plain', sizeBytes: longText.length, createdAt: time, updatedAt: time },
  { path: 'interactive.html', contentType: 'text/html', sizeBytes: html.length, createdAt: time, updatedAt: time },
  { path: 'brief.pdf', contentType: 'application/pdf', sizeBytes: pdf.length, createdAt: time, updatedAt: time },
  { path: 'reading.pdf', contentType: 'application/pdf', sizeBytes: readingPdf.length, createdAt: time, updatedAt: time },
  { path: 'reading.md', contentType: 'text/markdown', sizeBytes: markdown.length, createdAt: time, updatedAt: time },
  { path: 'icon.svg', contentType: 'image/svg+xml', sizeBytes: svg.length, createdAt: time, updatedAt: time },
  { path: longPath, contentType: 'text/plain', sizeBytes: 4, createdAt: time, updatedAt: time },
];

const uploadLabels = {
  en: { back: 'Back to files', path: 'Target relative path', submit: 'Upload file', overview: 'Overview', attachments: 'Attachments', invalid: 'Enter a valid relative path.' },
  'zh-CN': { back: '返回文件', path: '目标相对路径', submit: '上传文件', overview: '概览', attachments: '附件', invalid: '请输入有效的相对路径。' },
} as const;

const uploadGeometry = (attachments: Locator) => attachments.evaluate(element => {
  const split = element.querySelector<HTMLElement>('.attachment-split')!;
  const form = element.querySelector<HTMLElement>('.attachment-upload')!;
  const input = form.querySelector<HTMLInputElement>('input[type=text]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const bounds = split.getBoundingClientRect();
  return {
    split: { width: split.clientWidth, left: bounds.left, right: bounds.right },
    input: { width: input.getBoundingClientRect().width, font: getComputedStyle(input).fontSize },
    form: { width: form.clientWidth, scrollWidth: form.scrollWidth },
    submit: { left: submit.getBoundingClientRect().left, right: submit.getBoundingClientRect().right },
    filename: form.querySelector('.attachment-upload-filename')?.textContent,
    documentFits: document.documentElement.scrollWidth <= innerWidth,
  };
});

for (const goal of [false, true]) for (const mobile of [false, true]) {
  test(`${goal ? 'Goal' : 'Task'} attachment sidebar typography at ${mobile ? '320px with a 24px root' : 'desktop'}`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 320, height: 900 } : { width: 1360, height: 900 });
    const state = await install(page, false, false, undefined, goal);
    const filename = `${'long-filename-'.repeat(8)}end.txt`;
    state.files.push({ path: filename, contentType: 'text/plain', sizeBytes: longText.length, createdAt: time, updatedAt: time });
    await page.route(`**/attachments/files/${filename}`, route => route.fulfill({ contentType: 'text/plain', body: longText, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
    const sessionId = '00000000-0000-4000-8000-000000000051';
    await page.route(url => url.pathname === `${root}/sessions`, route => route.fulfill({ contentType: 'application/json', headers: { 'Daynight-User-ID': TEST_VIEWER_ID }, body: stringifyWireJson({ items: [{ sessionId, claimId: successorId, executionGeneration: '1', agentControlMode: 'web', contentKind: 'native_timeline', createdAt: time, endedAt: time, archive: { state: 'unavailable', sha256: null, byteLength: null, completeness: null } }], nextCursor: null }) }));
    await page.route(`**/sessions/${sessionId}/archive`, route => route.fulfill({ contentType: 'application/json', headers: { 'Daynight-User-ID': TEST_VIEWER_ID }, body: stringifyWireJson({ archive: { state: 'unavailable', sha256: null, byteLength: null, errorCode: null } }) }));
    if (goal) {
      await page.goto(`/projects/${projectId}`);
      await page.locator('#project-section-tab-tasks').click();
      await page.getByRole('tab', { name: 'Goals', exact: true }).click();
      await page.locator(`#project-goal-detail-${taskId}`).click();
      await page.locator('.goal-detail-surface').getByRole('tab', { name: 'Attachments', exact: true }).click();
    } else await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=attachments`);
    if (mobile) await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    const attachments = page.locator('.task-attachments');
    const sm = mobile ? '21px' : '14px', xs = mobile ? '18px' : '12px';
    await expect(attachments.locator('.attachment-section-heading h4')).toHaveCSS('font-size', sm);
    await expect(attachments.locator('.attachment-section-heading .button')).toHaveCSS('font-size', sm);
    const disclosure = attachments.locator('.attachment-upload-disclosure');
    await expect(disclosure.locator('summary')).toHaveCSS('font-size', sm);
    const row = treeRow(attachments, filename);
    for (const selector of ['.attachment-file', '.attachment-file-icon', '.attachment-file-name', '.attachment-file-size', '.attachment-actions-trigger']) {
      await expect(row.locator(selector)).toHaveCSS('font-size', xs);
    }
    await expect(attachments.locator('.attachment-tree summary').first()).toHaveCSS('font-size', sm);
    if (goal) await expect(attachments.locator('.managed-session-records')).toHaveCount(0);
    else {
      const records = attachments.locator('.managed-session-records');
      await expect(records.locator('h4')).toHaveCSS('font-size', sm);
      await expect(records.locator('.terminal-host-toolbar .button')).toHaveCSS('font-size', sm);
      const record = records.locator('.managed-session-list .button');
      await expect(record).toHaveText(/2026-10-20 09:00:00Z · Web ·/);
      await expect(record).toHaveCSS('font-size', xs);
      await record.click();
      await expect(attachments.locator('.attachment-record-preview')).toContainText('No recording is available for this execution.');
    }
    const file = row.locator('.attachment-file');
    await file.click();
    await expect(file).toHaveAttribute('aria-pressed', 'true');
    await expect(attachments.locator('.attachment-preview-header h5')).toHaveText(filename);
    await expect(attachments.locator('.attachment-preview-header h5')).toHaveCSS('font-size', sm);
    await expect(attachments.locator('.attachment-text')).toHaveText(longText);
    await row.locator('.attachment-actions-trigger').click();
    await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCSS('font-size', sm);
    await page.keyboard.press('Escape');
    await disclosure.locator('summary').click();
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.locator('.attachment-upload label').first()).toHaveCSS('font-size', sm);
    if (mobile) await attachments.getByRole('button', { name: 'Back to files', exact: true }).click();
    else await disclosure.locator('summary').click();
    await expect(disclosure).not.toHaveAttribute('open');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(state.writes).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const viewport of [{ width: 320, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
  test(`attachment upload fills narrow container at ${viewport.width}px in ${locale}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, hasTouch: true });
    const page = await context.newPage();
    try {
      const state = await install(page);
      if (viewport.width === 320) state.files = [];
      await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=attachments`);
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const attachments = page.locator('.task-attachments');
      const split = attachments.locator('.attachment-split');
      const labels = uploadLabels[locale];
      await attachments.locator('.attachment-upload-disclosure summary').tap();
      await expect(split).toHaveClass(/attachment-upload-fullscreen/);
      await expect(attachments.locator('.attachment-sidebar-browser')).toHaveAttribute('inert', '');
      await expect(attachments.locator('.attachment-preview-pane')).toHaveAttribute('inert', '');
      const back = attachments.getByRole('button', { name: labels.back, exact: true });
      const input = attachments.locator('input[type=file]');
      await expect(input).toBeFocused();
      const name = viewport.width === 390 ? `${'release-checklist-'.repeat(8)}final.md` : 'release-checklist.md';
      await input.setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from('# Release checklist') });
      const chosen = await input.evaluateHandle((element: HTMLInputElement) => element.files![0]!);
      const originalInput = await input.elementHandle();
      const path = attachments.getByRole('textbox', { name: labels.path });
      await path.fill('docs/release/checklist.md');
      await expect(attachments.locator('.attachment-upload-filename')).toContainText(name);
      const geometry = await uploadGeometry(attachments);
      if (viewport.width === 320) expect(geometry.input.width).toBeGreaterThanOrEqual(250);
      expect(geometry.input.font).toBe('16px');
      expect(geometry.form.scrollWidth).toBeLessThanOrEqual(geometry.form.width + 1);
      expect(geometry.submit.right).toBeLessThanOrEqual(geometry.split.right);
      expect(geometry.documentFits).toBe(true);
      const submit = attachments.getByRole('button', { name: labels.submit, exact: true });
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeInViewport({ ratio: 1 });
      await path.fill('../invalid.md');
      await submit.click();
      await expect(path).toHaveAttribute('aria-invalid', 'true');
      expect(state.writes).toEqual([]);
      await path.fill(`docs/${'release-directory/'.repeat(20)}checklist.md`);
      await path.press('Home');
      expect(await path.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(0);
      await path.press('End');
      expect(await path.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe((await path.inputValue()).length);
      await back.click();
      await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
      await expect(attachments.locator('.attachment-upload-disclosure summary')).toBeFocused();
      await attachments.locator('.attachment-upload-disclosure summary').press('Enter');
      await expect(split).toHaveClass(/attachment-upload-fullscreen/);
      expect(await originalInput!.evaluate(element => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
      expect(await input.evaluate((element: HTMLInputElement, file) => element.files![0] === file, chosen)).toBe(true);
      await path.fill('docs/release/checklist.md');
      await path.press('Escape');
      await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
      await attachments.locator('.attachment-upload-disclosure summary').click();
      await expect(path).toHaveValue('docs/release/checklist.md');
      await back.click();
      await page.getByRole('tab', { name: labels.overview, exact: true }).click();
      await page.getByRole('tab', { name: labels.attachments, exact: true }).click();
      await attachments.locator('.attachment-upload-disclosure summary').click();
      await expect(path).toHaveValue('docs/release/checklist.md');
      expect(await input.evaluate((element: HTMLInputElement, file) => element.files![0] === file, chosen)).toBe(true);
      await path.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`upload-${locale}-${viewport.width}.png`) });
      await writeFile(test.info().outputPath('upload-geometry.json'), JSON.stringify({ locale, viewport, geometry }, null, 2));
      expect(state.writes).toEqual([]);
      await chosen.dispose(); await originalInput!.dispose();
    } finally { await context.close(); }
  });
}

test('attachment upload retains native input and browser state across its actual 559/560px boundary', async ({ page }) => {
  const state = await install(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/reading.txt`);
  const attachments = page.locator('.task-attachments');
  const split = attachments.locator('.attachment-split');
  const body = attachments.locator('.attachment-preview-body').filter({ has: page.locator('pre') });
  await expect(body.locator('pre')).toHaveText(longText);
  await body.evaluate(element => { element.scrollTop = 350; });
  const scroll = await body.evaluate(element => element.scrollTop);
  await attachments.locator('.attachment-upload-disclosure summary').click();
  const input = attachments.locator('input[type=file]');
  await input.setInputFiles({ name: 'boundary.md', mimeType: 'text/markdown', buffer: Buffer.from('# Boundary') });
  const chosen = await input.evaluateHandle((element: HTMLInputElement) => element.files![0]!);
  const path = attachments.getByRole('textbox', { name: 'Target relative path' });
  await path.fill('drafts/boundary.md');
  await path.focus();
  for (const width of [559, 560, 559, 768]) {
    await split.evaluate((element: HTMLElement, width) => { element.style.flex = 'none'; element.style.width = `${width + 2}px`; }, width);
    await expect.poll(() => split.evaluate(element => element.clientWidth)).toBe(width);
    if (width < 560) await expect(split).toHaveClass(/attachment-upload-fullscreen/);
    else await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
    await expect(path).toBeFocused();
    await expect(path).toHaveValue('drafts/boundary.md');
    expect(await input.evaluate((element: HTMLInputElement, file) => element.files![0] === file, chosen)).toBe(true);
  }
  for (const browserControl of [attachments.getByRole('button', { name: /^reading\.txt/ }), attachments.getByRole('link', { name: 'Download', exact: true })]) {
    await split.evaluate((element: HTMLElement) => { element.style.width = '770px'; });
    await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
    await browserControl.focus();
    await split.evaluate((element: HTMLElement) => { element.style.width = '561px'; });
    await expect(split).toHaveClass(/attachment-upload-fullscreen/);
    await expect(input).toBeFocused();
  }
  await split.evaluate((element: HTMLElement) => { element.style.width = '561px'; });
  await expect(split).toHaveClass(/attachment-upload-fullscreen/);
  await attachments.getByRole('button', { name: 'Back to files', exact: true }).focus();
  await split.evaluate((element: HTMLElement) => { element.style.width = '562px'; });
  await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
  await expect(input).toBeFocused();
  await page.setViewportSize({ width: 768, height: 900 });
  await split.evaluate((element: HTMLElement) => { element.style.removeProperty('flex'); element.style.removeProperty('width'); });
  await path.press('Escape');
  await expect(attachments.locator('.attachment-upload-disclosure')).not.toHaveAttribute('open');
  await expect(attachments.locator('.attachment-preview-header h5')).toHaveText('reading.txt');
  expect(await body.evaluate(element => element.scrollTop)).toBe(scroll);
  expect(state.writes).toEqual([]);
  await chosen.dispose();
});

for (const goal of [false, true]) {
  test(`attachment upload keeps failed and pending drafts then selects submitted content for ${goal ? 'Goal' : 'Task'}`, async ({ page }) => {
    const state = await install(page, false, false, undefined, goal);
    await page.setViewportSize({ width: 375, height: 667 });
    const destination = 'docs/release/checklist.md';
    const payload = '# Uploaded checklist\n\nReady to release.';
    const requests: { method: string; path: string; body: string | null; contentType: string | undefined }[] = [];
    const pending = Promise.withResolvers<void>();
    let attempt = 0;
    await page.route(`**/attachments/files/${destination}`, async route => {
      if (route.request().method() === 'GET') return route.fulfill({ contentType: 'text/markdown', body: payload, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
      const request = route.request();
      requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData(), contentType: request.headers()['content-type'] });
      if (++attempt === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: stringifyWireJson({ error: { code: 'storage_failed', message: 'Fixture upload failure', requestId: 'upload-fixture' } }), headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
      await pending.promise;
      const uploaded = { path: destination, contentType: 'text/markdown', sizeBytes: Buffer.byteLength(payload), createdAt: time, updatedAt: time };
      state.files.push(uploaded);
      return route.fulfill({ status: 201, contentType: 'application/json', body: stringifyWireJson(uploaded), headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    });
    try {
      await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=attachments`);
      const attachments = page.locator('.task-attachments');
      await attachments.locator('.attachment-upload-disclosure summary').click();
      const input = attachments.locator('input[type=file]');
      await input.setInputFiles({ name: 'release-checklist.md', mimeType: 'text/markdown', buffer: Buffer.from(payload) });
      const chosen = await input.evaluateHandle((element: HTMLInputElement) => element.files![0]!);
      const path = attachments.getByRole('textbox', { name: 'Target relative path' });
      await path.fill(destination);
      await attachments.getByRole('button', { name: 'Upload file', exact: true }).click();
      await expect(attachments.locator('.attachment-upload').getByRole('alert')).toContainText('upload-fixture');
      await expect(path).toHaveValue(destination);
      expect(await input.evaluate((element: HTMLInputElement, file) => element.files![0] === file, chosen)).toBe(true);
      await attachments.getByRole('button', { name: 'Upload file', exact: true }).click();
      await expect(attachments.getByRole('button', { name: 'Uploading…', exact: true })).toBeDisabled();
      await expect(path).toBeDisabled();
      await expect(input).toBeDisabled();
      await attachments.getByRole('button', { name: 'Back to files', exact: true }).click();
      await attachments.locator('.attachment-upload-disclosure summary').click();
      await expect(path).toHaveValue(destination);
      await expect(attachments.getByRole('button', { name: 'Uploading…', exact: true })).toBeDisabled();
      await attachments.getByRole('button', { name: 'Back to files', exact: true }).focus();
      await page.setViewportSize({ width: 1360, height: 900 });
      await expect(attachments.locator('.attachment-split')).not.toHaveClass(/attachment-upload-fullscreen/);
      await expect(attachments.locator('.attachment-upload-disclosure summary')).toBeFocused();
      await page.setViewportSize({ width: 375, height: 667 });
      await expect(attachments.getByRole('button', { name: 'Back to files', exact: true })).toBeFocused();
      pending.resolve();
      await expect(attachments.locator('.attachment-split')).not.toHaveClass(/attachment-upload-fullscreen/);
      const uploaded = attachments.locator('.attachment-file').filter({ hasText: 'checklist.md' });
      await expect(uploaded).toBeFocused();
      await expect(attachments.locator('.attachment-preview-header h5')).toHaveText(destination);
      await expect(attachments.locator('.attachment-markdown')).toContainText('Ready to release.');
      expect(requests).toEqual([1, 2].map(() => ({ method: 'PUT', path: `${root}/attachments/files/${destination}`, body: payload, contentType: 'text/markdown' })));
      await attachments.locator('.attachment-upload-disclosure summary').click();
      await expect(path).toHaveValue('');
      expect(await input.evaluate((element: HTMLInputElement) => element.files!.length)).toBe(0);
      await chosen.dispose();
    } finally { pending.resolve(); }
  });
}

test('attachment upload Escape preserves its dialog and fullscreen draft', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  const { dialog, attachments } = await openDialog(page);
  const split = attachments.locator('.attachment-split');
  await split.evaluate((element: HTMLElement) => { element.style.flex = 'none'; element.style.width = '502px'; });
  await attachments.locator('.attachment-upload-disclosure summary').click();
  await expect(split).toHaveClass(/attachment-upload-fullscreen/);
  const input = attachments.locator('input[type=file]');
  await input.setInputFiles({ name: 'dialog.md', mimeType: 'text/markdown', buffer: Buffer.from('Dialog draft') });
  const path = attachments.getByRole('textbox', { name: 'Target relative path' });
  await path.fill('drafts/dialog.md');
  await path.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(attachments.locator('.attachment-upload-disclosure summary')).toBeFocused();
  await attachments.locator('.attachment-upload-disclosure summary').click();
  await dialog.locator('.task-detail-fullscreen-toggle').click();
  await expect(dialog).toHaveClass(/task-detail-fullscreen/);
  await expect(path).toHaveValue('drafts/dialog.md');
  expect(await input.evaluate((element: HTMLInputElement) => element.files![0]!.name)).toBe('dialog.md');
  await dialog.locator('.task-detail-fullscreen-toggle').press('Escape');
  await expect(dialog).toHaveClass(/task-detail-fullscreen/);
  await expect(dialog).toBeVisible();
  await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
  await expect(attachments.locator('.attachment-upload-disclosure summary')).toBeFocused();
  await attachments.locator('.attachment-upload-disclosure summary').click();
  await expect(path).toHaveValue('drafts/dialog.md');
  await dialog.getByRole('tab', { name: 'Attachments', exact: true }).press('Escape');
  await expect(dialog).toBeVisible();
  await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
});

test('attachment upload reconciles an open file menu when its container narrows', async ({ page }) => {
  const state = await install(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  const { dialog, attachments } = await openDialog(page);
  const split = attachments.locator('.attachment-split');
  expect(await split.evaluate(element => element.clientWidth)).toBeGreaterThanOrEqual(560);
  await attachments.locator('.attachment-upload-disclosure summary').click();
  const input = attachments.locator('input[type=file]');
  await input.setInputFiles({ name: 'menu-resize.md', mimeType: 'text/markdown', buffer: Buffer.from('# Retained menu resize draft') });
  const chosen = await input.evaluateHandle((element: HTMLInputElement) => element.files![0]!);
  const originalInput = await input.elementHandle();
  const path = attachments.getByRole('textbox', { name: 'Target relative path' });
  await path.fill('drafts/menu-resize.md');
  await attachments.getByRole('button', { name: 'More actions: reading.txt', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
  await split.evaluate((element: HTMLElement) => { element.style.flex = 'none'; element.style.width = '561px'; });
  await expect(split).toHaveClass(/attachment-upload-fullscreen/);
  await expect(menu).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(path).toHaveValue('drafts/menu-resize.md');
  expect(await input.evaluate((element: HTMLInputElement, file) => element.files![0] === file, chosen)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('upload-menu-resize.png') });
  await split.evaluate((element: HTMLElement) => { element.style.width = '562px'; });
  await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
  await expect(menu).toHaveCount(0);
  await split.evaluate((element: HTMLElement) => { element.style.width = '561px'; });
  await expect(split).toHaveClass(/attachment-upload-fullscreen/);
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
  await expect(attachments.locator('.attachment-upload-disclosure summary')).toBeFocused();
  await attachments.locator('.attachment-upload-disclosure summary').click();
  await expect(path).toHaveValue('drafts/menu-resize.md');
  expect(await originalInput!.evaluate(element => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
  expect(await input.evaluate((element: HTMLInputElement, file) => element.files![0] === file, chosen)).toBe(true);
  expect(state.writes).toEqual([]);
  await chosen.dispose(); await originalInput!.dispose();
});

test('attachment upload preserves its dialog after canceling a confirmation across a narrow transition', async ({ page }) => {
  const state = await install(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  const { dialog, attachments } = await openDialog(page);
  const split = attachments.locator('.attachment-split');
  await attachments.locator('.attachment-upload-disclosure summary').click();
  const input = attachments.locator('input[type=file]');
  await input.setInputFiles({ name: 'confirmation-resize.md', mimeType: 'text/markdown', buffer: Buffer.from('# Retained confirmation draft') });
  const chosen = await input.evaluateHandle((element: HTMLInputElement) => element.files![0]!);
  const originalInput = await input.elementHandle();
  const path = attachments.getByRole('textbox', { name: 'Target relative path' });
  await path.fill('drafts/confirmation-resize.md');
  await attachments.getByRole('button', { name: 'More actions: reading.txt', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const confirmation = page.locator('.attachment-delete-dialog');
  const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();
  await split.evaluate((element: HTMLElement) => { element.style.flex = 'none'; element.style.width = '561px'; });
  await expect(split).toHaveClass(/attachment-upload-fullscreen/);
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(confirmation).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath('upload-confirmation-resize.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(split).not.toHaveClass(/attachment-upload-fullscreen/);
  await attachments.locator('.attachment-upload-disclosure summary').click();
  await expect(path).toHaveValue('drafts/confirmation-resize.md');
  expect(await originalInput!.evaluate(element => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
  expect(await input.evaluate((element: HTMLInputElement, file) => element.files![0] === file, chosen)).toBe(true);
  expect(state.writes).toEqual([]);
  await chosen.dispose(); await originalInput!.dispose();
});

const treeDirectory = 'docs/architecture/current/reviews/figures/mobile';
const treePath = `${treeDirectory}/overview.md`;
const deeperTreePath = `${treeDirectory}/extra/deeper/leaf/overview.md`;
const treePaths = [treePath, deeperTreePath, `${treeDirectory}/a-long-English-file-name-with-readable-segments.md`, `${treeDirectory}/附件目录中的完整中文文件名称与说明文档.md`, 'overview.md'];

const installDeepTree = async (page: Page, goal: boolean) => {
  const state = await install(page, false, false, undefined, goal);
  state.files.push(...treePaths.map(path => ({ path, contentType: 'text/markdown', sizeBytes: longText.length, createdAt: time, updatedAt: time })));
  await page.route(url => url.pathname.startsWith(`${root}/attachments/files/`) && treePaths.some(path => decodeURIComponent(url.pathname) === `${root}/attachments/files/${path}`), route => route.fulfill({ contentType: 'text/markdown', body: `# Deep tree reading\n\n${longText}`, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
  return state;
};

const treeRow = (attachments: Locator, path: string) => attachments.getByRole('button', { name: `More actions: ${path}`, exact: true }).locator('..');

const openTreePath = async (attachments: Locator, path: string, input: 'tap' | 'keyboard') => {
  const segments = path.split('/').slice(0, -1);
  let list = attachments.locator('.attachment-files > .attachment-tree');
  for (const segment of segments) {
    const directory = list.locator(':scope > li > details').filter({ has: attachments.page().locator('summary', { hasText: new RegExp(`^▱\\s*${segment}$`) }) });
    if (await directory.getAttribute('open') === null) {
      const summary = directory.locator(':scope > summary');
      if (input === 'tap') await summary.tap();
      else { await summary.focus(); await attachments.page().keyboard.press('Enter'); }
    }
    await expect(directory).toHaveAttribute('open', '');
    list = directory.locator(':scope > .attachment-tree');
  }
};

test.describe('deep attachment tree', () => {
  test.use({ hasTouch: true });
  for (const goal of [false, true]) for (const mode of ['standalone', 'dialog'] as const) {
    test(`${goal ? 'Goal' : 'Task'} ${mode} keeps deep filenames and actions usable through width and fullscreen changes`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 900 });
      const state = await installDeepTree(page, goal);
      if (mode === 'standalone') await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/${treePath}`);
      else if (goal) {
        await page.goto(`/projects/${projectId}`);
        await page.locator('#project-section-tab-tasks').click();
        await page.getByRole('tab', { name: 'Goals', exact: true }).click();
        await page.locator(`#project-goal-detail-${taskId}`).click();
        await page.locator('.goal-detail-surface').getByRole('tab', { name: 'Attachments', exact: true }).click();
      } else await openDialog(page);
      const surface = page.locator(mode === 'standalone' ? '.task-detail-page' : '.task-detail-dialog');
      const attachments = surface.locator('.task-attachments');
      await openTreePath(attachments, treePath, 'tap');
      const row = treeRow(attachments, treePath), file = row.locator('.attachment-file');
      await file.tap();
      await expect(attachments.getByRole('heading', { name: 'Deep tree reading', exact: true })).toBeVisible();
      await openTreePath(attachments, deeperTreePath, 'keyboard');
      await treeRow(attachments, deeperTreePath).locator('.attachment-file').focus();
      await page.keyboard.press('Enter');
      await expect(attachments.locator('.attachment-preview-header h5')).toHaveAttribute('title', deeperTreePath);
      await file.click();

      const disclosure = attachments.locator('.attachment-upload-disclosure');
      await disclosure.locator('summary').click();
      const upload = attachments.locator('input[type=file]');
      await upload.setInputFiles({ name: 'unsent.txt', mimeType: 'text/plain', buffer: Buffer.from('retained draft') });
      const target = attachments.locator('.attachment-upload input[type=text]');
      await target.fill('drafts/unsent.txt');
      await attachments.getByRole('button', { name: 'Back to files', exact: true }).click();
      const originalFile = await file.elementHandle(), originalUpload = await upload.elementHandle();

      for (const width of [320, 375, 390, 421, 480, 768, 1360]) {
        await page.setViewportSize({ width, height: width === 320 ? 640 : width === 375 ? 667 : width < 768 ? 844 : 900 });
        await row.scrollIntoViewIfNeeded();
        const geometry = await row.evaluate(element => {
          const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
          const name = box('.attachment-file-name'), size = box('.attachment-file-size'), action = box('.attachment-actions-trigger');
          const sidebar = element.closest('.attachment-sidebar')!.getBoundingClientRect();
          return { nameWidth: name.width, nameRight: name.right, sizeTop: size.top, nameBottom: name.bottom, actionWidth: action.width, actionHeight: action.height, actionRight: action.right, sidebarRight: sidebar.right, overflow: element.scrollWidth > element.clientWidth + 1 };
        });
        if (width === 320) expect(geometry.nameWidth).toBeGreaterThanOrEqual(44);
        expect(geometry.actionWidth).toBeGreaterThanOrEqual(28);
        expect(geometry.actionHeight).toBeGreaterThanOrEqual(28);
        expect(geometry.actionRight).toBeLessThanOrEqual(geometry.sidebarRight + 1);
        expect(geometry.nameRight).toBeLessThanOrEqual(geometry.sidebarRight + 1);
        expect(geometry.overflow).toBe(false);
        if (width <= 768) expect(geometry.sizeTop).toBeGreaterThanOrEqual(geometry.nameBottom - 1);
        const cappedStarts = await Promise.all([row, treeRow(attachments, deeperTreePath)].map(entry => entry.evaluate(element => element.getBoundingClientRect().left)));
        expect(Math.abs(cappedStarts[0]! - cappedStarts[1]!)).toBeLessThanOrEqual(1);
        const panes = await attachments.locator('.attachment-sidebar,.attachment-preview-pane').evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
        }));
        expect(panes[0]!.right).toBeLessThanOrEqual(panes[1]!.left + 1);
        expect(Math.abs(panes[0]!.top - panes[1]!.top)).toBeLessThanOrEqual(1);
        expect(panes[1]!.width).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const path of treePaths.slice(2, 4)) {
          const name = treeRow(attachments, path).locator('.attachment-file-name');
          expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        }
        await expect(file).toHaveAttribute('aria-pressed', 'true');
        await expect(target).toHaveValue('drafts/unsent.txt');
      }

      await page.setViewportSize({ width: 320, height: 640 });
      const trigger = row.locator('.attachment-actions-trigger');
      await trigger.tap();
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await surface.getByRole('tab', { name: goal ? 'Description' : 'Overview', exact: true }).click();
      await surface.getByRole('tab', { name: 'Attachments', exact: true }).click();
      const fullscreen = surface.locator('.task-detail-fullscreen-toggle');
      await fullscreen.click();
      await expect(surface).toHaveClass(/task-detail-fullscreen/);
      await fullscreen.click();
      await expect(surface).not.toHaveClass(/task-detail-fullscreen/);
      expect(await originalFile!.evaluate(element => element.isConnected)).toBe(true);
      expect(await originalUpload!.evaluate(element => element.isConnected)).toBe(true);
      await expect(file).toHaveAttribute('aria-pressed', 'true');
      await expect(target).toHaveValue('drafts/unsent.txt');
      expect(await upload.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe('unsent.txt');
      await expect(treeRow(attachments, deeperTreePath).locator('.attachment-file')).toBeVisible();

      const sidebar = attachments.locator('.attachment-sidebar'), body = attachments.locator('.attachment-preview-body');
      const bodyTop = await body.evaluate(element => { element.scrollTop = 100; return element.scrollTop; });
      expect(bodyTop).toBeGreaterThan(0);
      const sidebarTop = await sidebar.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
      expect(sidebarTop).toBeGreaterThan(0);
      expect(await body.evaluate(element => element.scrollTop)).toBe(bodyTop);
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      expect(await sidebar.evaluate(element => element.scrollTop)).toBe(sidebarTop);
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath('deep-tree-320.png') });
      await originalFile!.dispose(); await originalUpload!.dispose();
      expect(state.writes).toEqual([]);
    });
  }
});

async function install(page: Page, linked = false, claimed = false, description?: string, goal = false) {
  const worker = { claimId: successorId, state: 'active', userId: TEST_VIEWER_ID, workerId: projectId, machine: { id: projectId, name: 'Worker machine' }, platform: 'linux', agent: 'codex', agentControlMode: 'herdr', worktreeId: taskId, phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time };
  const task = detailFixture(projectId, taskId, { title: 'Attachment reading', version: 5n, ...(goal ? { type: 'goal' as const, ready: false, progress: { total: 0, done: 0, cancelled: 0, unfinished: 0 } } : {}), ...(description === undefined ? {} : { description }), ...(claimed ? { status: 'in_progress', startedAt: time, ready: false, assignedTo: TEST_VIEWER_ID, allowAgents: true, properties: { worker } } : {}) });
  const successor = detailFixture(projectId, successorId, { title: 'Linked successor', version: 5n, dependsOn: [taskId], blockedBy: [taskId], ready: false });
  const graph = graphFixture(linked ? [task, successor] : [task]);
  const state = { writes: [] as string[], resources: [] as string[], requests: [] as { method: string; origin: string; path: string }[], accessReads: 0, holdAccess: null as Promise<void> | null, files: files.map(file => ({ ...file })) };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.startsWith(`${root}/preview/`)) state.requests.push({ method: request.method(), origin: url.origin, path });
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') {
      return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    }
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) { state.accessReads++; if (state.holdAccess) await state.holdAccess; return send(directAccessFixture(projectId)); }
    if (path === `/api/v1/projects/${projectId}/members`) return send({ actorAccess: directAccessFixture(projectId), items: [{ inheritedFrom: null, userId: TEST_VIEWER_ID, profile: { name: 'Reader', email: null, avatarUrl: null }, effectiveRole: 'admin', directGrant: directAccessFixture(projectId).directGrant }] });
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: TEST_VIEWER_ID, name: 'Reader', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    if (path === `/api/v1/projects/${projectId}/task-graph`) return send(graph);
    if (path === root || linked && path === `/api/v1/projects/${projectId}/tasks/${successorId}`) return route.fulfill({
      body: stringifyWireJson(path === root ? task : successor),
      headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': taskSyncEpoch(projectId) },
    });
    if (linked && path === `/api/v1/projects/${projectId}/tasks/${successorId}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${root}/attachments`) return send({ items: state.files, nextCursor: null });
    if (path === `${root}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${root}/sessions/current` && claimed) return send({ status: 'not_registered', claimId: worker.claimId, agentControlMode: 'herdr' });
    if (path === `${root}/attachments/files/reading.md`) return route.fulfill({ body: markdown, headers: { 'Content-Type': 'text/markdown', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path.startsWith(`${root}/preview/`)) state.resources.push(path);
    if (path === `${root}/preview/style.css`) return route.fulfill({ body: 'body { background: rgb(246, 247, 252) }', headers: { 'Content-Type': 'text/css' } });
    if (path === `${root}/preview/app.js`) return route.fulfill({ body: script, headers: { 'Content-Type': 'text/javascript' } });
    if (path === `${root}/preview/data.json`) return route.fulfill({ body: JSON.stringify({ label: 'Relative JSON loaded' }), headers: { 'Content-Type': 'application/json' } });
    if (path === `${root}/preview/icon.svg`) return route.fulfill({ body: svg, headers: { 'Content-Type': 'image/svg+xml', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/attachments/files/acceptance-evidence.json`) return route.fulfill({ body: '{}', headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/attachments/files/reading.txt`) return route.fulfill({ body: longText, headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/attachments/files/${longPath}`) return route.fulfill({ body: longText, headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/preview/reading.pdf`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : readingPdf, headers: { 'Content-Type': 'application/pdf', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/preview/brief.pdf`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : pdf, headers: { 'Content-Type': 'application/pdf', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${root}/preview/interactive.html`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : html, headers: { 'Content-Type': 'text/html', 'Daynight-User-ID': TEST_VIEWER_ID } });
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}

async function checkDuringForeground(page: Page, state: Awaited<ReturnType<typeof install>>, check: () => Promise<void>) {
  const gate = Promise.withResolvers<void>();
  state.holdAccess = gate.promise;
  const reads = state.accessReads;
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.accessReads).toBeGreaterThan(reads);
    await check();
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/access`);
    state.holdAccess = null; gate.resolve(); await completed;
    await check();
  } finally { state.holdAccess = null; gate.resolve(); }
}

test('modified click on a Task attachment link opens its preview in a new tab', async ({ page }) => {
  const server = createServer((request, response) => {
    if (request.headers.host !== `${taskId}.preview.localhost:${port}` || request.url !== `${root}/preview/interactive.html`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Task preview</title><p>Preview contents</p>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  try {
    await install(page, false, false, '[Open preview](interactive.html)');
    const path = `/projects/${projectId}/tasks/${taskId}`;
    await page.route(url => url.hostname === '127.0.0.1' && url.pathname === path, async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('http://preview.localhost:8787', `http://preview.localhost:${port}`);
      await route.fulfill({ response, body });
    });
    await page.goto(path);
    const link = page.getByRole('link', { name: 'Open preview', exact: true });
    const target = `http://${taskId}.preview.localhost:${port}${root}/preview/interactive.html`;
    await expect(link).toHaveAttribute('href', target);
    const before = page.url();
    const [popup] = await Promise.all([page.context().waitForEvent('page'), link.click({ modifiers: ['Control'] })]);
    await expect(popup).toHaveURL(target);
    await expect(popup.getByText('Preview contents')).toBeVisible();
    expect(page.url()).toBe(before);
    await popup.close();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('a linked attachment image opens preview sign-in without following the outer link', async ({ page }) => {
  await install(page, false, false, '[![Linked image](linked.svg)](other.md)');
  await page.route('**/preview/linked.svg', route => route.abort('failed'));
  await page.context().route('**/auth/sso/start', route => route.fulfill({ contentType: 'text/html', body: '<title>Preview sign-in</title>' }));
  await page.goto(`/projects/${projectId}/tasks/${taskId}`);
  const alert = page.getByRole('alert', { name: 'Linked image' });
  await expect(alert).toBeVisible();
  const before = page.url();
  const [popup] = await Promise.all([page.context().waitForEvent('page'), alert.getByRole('link', { name: 'Sign in to preview' }).click()]);
  await expect(popup).toHaveURL('http://preview.localhost:8787/auth/sso/start');
  await expect(popup).toHaveTitle('Preview sign-in');
  expect(page.url()).toBe(before);
  await popup.close();
});

test('Markdown image retry preserves attachment drafts, selected document and retained HTML frame', async ({ page }) => {
  const state = await install(page, false, false, '# Task image\n\n![Task attachment](retry.svg)');
  const document = '# Document image\n\n' + 'Earlier reading paragraph.\n\n'.repeat(30) + '## Image recovery anchor\n\n![Document attachment](images/failed%20image.svg?view=one%2Ftwo#diagram)\n\n' + Array.from({ length: 60 }, (_, index) => `Retained paragraph ${index}.`).join('\n\n');
  state.files.push({ path: 'docs/reading.md', contentType: 'text/markdown', sizeBytes: document.length, createdAt: time, updatedAt: time });
  let documentReads = 0;
  await page.route('**/attachments/files/docs/reading.md', route => { documentReads++; return route.fulfill({ contentType: 'text/markdown', body: document, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }); });
  const images: string[] = [];
  const retryGate = Promise.withResolvers<void>();
  await page.route('**/preview/docs/images/failed%20image.svg?view=one%2Ftwo', async route => {
    images.push(route.request().url());
    if (images.length > 1) await retryGate.promise;
    return images.length === 1
      ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not_found"}}' })
      : route.fulfill({ contentType: 'image/svg+xml', body: svg });
  });
  let taskImages = 0;
  await page.route('**/preview/retry.svg', route => ++taskImages === 1 ? route.abort('failed') : route.fulfill({ contentType: 'image/svg+xml', body: svg }));
  await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/docs/reading.md`);
  const attachments = page.locator('.task-attachments');
  await attachments.locator('.attachment-upload-disclosure summary').click();
  const input = attachments.locator('input[type=file]');
  await input.setInputFiles({ name: 'unsent.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsent draft') });
  const inputHandle = await input.elementHandle();
  await attachments.getByRole('textbox', { name: 'Target relative path' }).fill('drafts/unsent.txt');
  await attachments.locator('.attachment-upload-disclosure summary').click();
  const reader = attachments.locator('.attachment-markdown').filter({ has: page.getByRole('heading', { name: 'Document image', exact: true }) });
  const error = reader.getByRole('alert');
  await expect(error).toContainText('Unable to load the attachment image');
  const before = [...state.resources];
  const reads = documentReads;
  await error.scrollIntoViewIfNeeded();
  const readingPosition = () => reader.getByRole('heading', { name: 'Image recovery anchor', exact: true }).evaluate(element => ({ top: element.closest('.attachment-preview-body')!.scrollTop, anchor: element.getBoundingClientRect().top }));
  const position = await readingPosition();
  expect(position.top).toBeGreaterThan(0);
  try {
    await error.getByRole('button', { name: 'Retry image', exact: true }).click();
    await expect.poll(() => images.length).toBe(2);
    await expect(error).toHaveCount(0);
    expect(await readingPosition()).toEqual(position);
  } finally { retryGate.resolve(); }
  const image = reader.getByRole('img', { name: 'Document attachment', exact: true });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
  expect(await readingPosition()).toEqual(position);
  await expect(error).toHaveCount(0);
  await expect(attachments.locator('.attachment-preview-header h5')).toHaveText('docs/reading.md');
  expect(images).toHaveLength(2); expect(images[0]).toBe(images[1]);
  expect(state.resources).toEqual(before); expect(documentReads).toBe(reads);
  expect(await inputHandle!.evaluate(element => element.isConnected)).toBe(true);
  expect(await input.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe('unsent.txt');
  await attachments.locator('.attachment-upload-disclosure summary').click();
  await expect(attachments.getByRole('textbox', { name: 'Target relative path' })).toHaveValue('drafts/unsent.txt');
  await attachments.locator('.attachment-upload-disclosure summary').click();
  await attachments.getByRole('button', { name: /^interactive\.html/ }).click();
  const frame = attachments.locator('iframe');
  const counter = frame.contentFrame().locator('#counter');
  await expect(counter).toHaveText('0');
  await counter.click(); await expect(counter).toHaveText('1');
  const frameHandle = await frame.elementHandle();
  await frame.contentFrame().locator('html').evaluate(element => { element.scrollTop = 500; });
  const frameScroll = await frame.contentFrame().locator('html').evaluate(element => element.scrollTop);
  const retainedResources = [...state.resources];
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const taskError = page.locator('.task-description').getByRole('alert');
  await expect(taskError).toContainText('Unable to load the attachment image');
  await taskError.getByRole('button', { name: 'Retry image', exact: true }).click();
  await expect.poll(() => page.locator('.task-description').getByRole('img', { name: 'Task attachment', exact: true }).evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(200);
  expect(taskImages).toBe(2); expect(state.resources).toEqual(retainedResources);
  await page.getByRole('tab', { name: 'Attachments', exact: true }).click();
  expect(await frameHandle!.evaluate(element => element.isConnected)).toBe(true);
  await expect(counter).toHaveText('1');
  expect(await frame.contentFrame().locator('html').evaluate(element => element.scrollTop)).toBe(frameScroll);
  expect(state.writes).toEqual([]);
  await frameHandle!.dispose(); await inputHandle!.dispose();
});

for (const locale of ['en', 'zh-CN'] as const) for (const viewport of [{ width: 1440, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) for (const claimed of [false, true]) {
  test(`attachment timestamps fit ${viewport.width}x${viewport.height} in ${locale}${claimed ? ' with claim' : ''}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await install(page, false, claimed);
    state.files = state.files.map(file => file.path === longPath ? { ...file, contentType: `application/${'long-mime-'.repeat(30)}json` } : file);
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/${longPath.split('/').map(encodeURIComponent).join('/')}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const surface = page.locator('.task-detail-page'), header = surface.locator('.attachment-preview-header');
    await expect(header.locator('h5')).toHaveAttribute('title', longPath);
    if (claimed) await expect(surface).toHaveClass(/task-detail-has-claim/);
    for (const fullscreen of [false, true]) {
      if (fullscreen) await surface.locator('.task-detail-fullscreen-toggle').click();
      const labels = header.locator('.attachment-timestamps dt'), values = header.locator('.attachment-timestamps time');
      await expect(labels).toHaveText(locale === 'en' ? ['Created', 'Last modified'] : ['创建时间', '最后修改时间']);
      await expect(values).toHaveCount(2);
      const starts = await values.evaluateAll(elements => elements.map(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect().left; }));
      expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThanOrEqual(1);
      for (const value of await values.all()) await expect(value).toHaveAttribute('datetime', time);
      for (const item of await header.locator('.attachment-timestamps dt,.attachment-timestamps time,.attachment-preview-actions a').all()) {
        await expect(item).toBeVisible();
        await expect(item).toBeInViewport({ ratio: 1 });
        expect(await item.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          const bounds = [...range.getClientRects()];
          if (bounds.length === 0) bounds.push(element.getBoundingClientRect());
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
            for (const text of bounds) {
              if (style.overflowX !== 'visible' && (text.left < rect.left - 1 || text.right > rect.right + 1)) return false;
              if (style.overflowY !== 'visible' && (text.top < rect.top - 1 || text.bottom > rect.bottom + 1)) return false;
            }
          }
          return true;
        })).toBe(true);
      }
      await expect(header.getByRole('link', { name: locale === 'en' ? 'Download' : '下载', exact: true })).toHaveAttribute('download', '');
      await expect(header.getByRole('link', { name: locale === 'en' ? 'Open in new tab' : '在新标签页打开' })).toHaveAttribute('target', '_blank');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    if (!claimed || viewport.width === 844) await page.screenshot({ path: test.info().outputPath('timestamp-layout.png') });
    expect(state.writes).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`short attachment information uses its content width in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await install(page);
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/acceptance-evidence.json`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const header = page.locator('.attachment-preview-header');
    await expect(header.locator('h5')).toHaveText('acceptance-evidence.json');
    await expect(header.locator('.attachment-file-information p')).toHaveText('application/json · 19,916 B');
    const boxes = await header.evaluate(element => {
      const info = element.querySelector('.attachment-file-information')!.getBoundingClientRect();
      const dates = element.querySelector('.attachment-timestamps')!.getBoundingClientRect();
      const title = element.querySelector('h5')!;
      const range = document.createRange(); range.selectNodeContents(title);
      return { width: info.width, textWidth: range.getBoundingClientRect().width, gap: dates.left - info.right };
    });
    expect(boxes.width).toBeLessThanOrEqual(240);
    expect(Math.abs(boxes.width - boxes.textWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes.gap - 16)).toBeLessThanOrEqual(1);
  });
}

test('attachment timestamps follow API selection and refreshed metadata', async ({ page }) => {
  const state = await install(page);
  const created = '2026-10-19T10:20:30Z', changed = '2026-10-21T11:22:33Z', refreshed = '2026-10-22T12:23:34Z';
  state.files = state.files.map(file => file.path === 'reading.txt' ? { ...file, createdAt: created, updatedAt: changed } : file);
  await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/reading.txt`);
  const attachments = page.locator('.task-attachments'), times = attachments.locator('.attachment-timestamps time');
  await expect(times).toHaveCount(2);
  await expect(times.nth(0)).toHaveAttribute('datetime', created);
  await expect(times.nth(1)).toHaveAttribute('datetime', changed);
  await attachments.getByRole('button', { name: /^reading\.md/ }).click();
  await expect(times.nth(0)).toHaveAttribute('datetime', time);
  await expect(times.nth(1)).toHaveAttribute('datetime', time);
  await attachments.getByRole('button', { name: /^reading\.txt/ }).click();
  await expect(times.nth(1)).toHaveAttribute('datetime', changed);
  state.files = state.files.map(file => file.path === 'reading.txt' ? { ...file, updatedAt: refreshed } : file);
  await attachments.getByRole('button', { name: 'Refresh attachments' }).click();
  await expect(times.nth(0)).toHaveAttribute('datetime', created);
  await expect(times.nth(1)).toHaveAttribute('datetime', refreshed);
  await expect(attachments.locator('.attachment-preview-body pre')).toHaveText(longText);
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const path of ['reading.txt', longPath]) {
  test(`compact claim header keeps timestamps and actions separate at 320x240 in ${locale}, ${path === longPath ? 'long' : 'short'} metadata`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 240 });
    const state = await install(page, false, true);
    const created = '2026-10-19T10:20:30Z', modified = '2026-10-21T11:22:33Z';
    state.files = state.files.map(file => file.path === path ? { ...file, createdAt: created, updatedAt: modified, ...(path === longPath ? { contentType: `text/plain; ${'long-mime-'.repeat(30)}` } : {}) } : file);
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/${path.split('/').map(encodeURIComponent).join('/')}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const surface = page.locator('.task-detail-page'), header = surface.locator('.attachment-preview-header');
    await expect(surface).toHaveClass(/task-detail-has-claim/);
    const labels = header.locator('.attachment-timestamps dt'), times = header.locator('.attachment-timestamps time');
    await expect(labels).toHaveText(locale === 'en' ? ['Created', 'Last modified'] : ['创建时间', '最后修改时间']);
    await expect(times).toHaveCount(2);
    await expect(times.nth(0)).toHaveAttribute('datetime', created);
    await expect(times.nth(1)).toHaveAttribute('datetime', modified);
    expect(await header.locator('.attachment-timestamps').evaluate(element => {
      const terms = [...element.querySelectorAll('dt')], values = [...element.querySelectorAll('time')];
      return terms.every((term, index) => term.nextElementSibling === values[index]?.parentElement);
    })).toBe(true);
    for (const fullscreen of [false, true]) {
      if (fullscreen) await surface.locator('.task-detail-fullscreen-toggle').click();
      const rects = await header.evaluate(element => {
        const bounds = (selector: string) => [...element.querySelectorAll(selector)].map(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          const r = range.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        const r = element.getBoundingClientRect();
        return { header: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, labels: bounds('.attachment-timestamps dt'), times: bounds('.attachment-timestamps time'), actions: [...element.querySelectorAll('.attachment-preview-actions a')].map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }) };
      });
      for (const item of [...rects.labels, ...rects.times, ...rects.actions]) {
        expect(item.left).toBeGreaterThanOrEqual(rects.header.left - 1);
        expect(item.right).toBeLessThanOrEqual(rects.header.right + 1);
      }
      // Vertical reachability is exercised by the keyboard scrolling matrix below.
      expect(Math.abs(rects.times[0]!.left - rects.times[1]!.left)).toBeLessThanOrEqual(1);
      for (let index = 0; index < 2; index++) expect(rects.labels[index]!.bottom).toBeLessThanOrEqual(rects.times[index]!.top + 1);
      expect(rects.times[0]!.bottom).toBeLessThanOrEqual(rects.labels[1]!.top + 1);
      for (const timeRect of [...rects.labels, ...rects.times]) for (const action of rects.actions) {
        expect(timeRect.right <= action.left + 1 || action.right <= timeRect.left + 1 || timeRect.bottom <= action.top + 1 || action.bottom <= timeRect.top + 1).toBe(true);
      }
      const download = header.getByRole('link', { name: locale === 'en' ? 'Download' : '下载', exact: true });
      const open = header.getByRole('link', { name: locale === 'en' ? 'Open in new tab' : '在新标签页打开' });
      await expect(download).toHaveAttribute('download', '');
      await expect(open).toHaveAttribute('target', '_blank');
      const body = surface.locator('.attachment-preview-body');
      await expect(body.locator('pre')).toHaveText(longText);
      const reading = await body.evaluate(element => { element.scrollTop = element.scrollHeight; return { height: element.clientHeight, atEnd: element.scrollTop + element.clientHeight >= element.scrollHeight - 1 }; });
      expect(reading.height).toBeGreaterThan(0);
      expect(reading.atEnd).toBe(true);
      await page.screenshot({ path: test.info().outputPath(fullscreen ? 'compact-fullscreen.png' : 'compact-claim.png') });
    }
    expect(state.writes).toEqual([]);
  });
}

// Text visibility is measured per character because a time can wrap and a
// scrollable header may show only part of it at any one scroll position.
async function visibleTimestampCharacters(header: Locator) {
  return header.evaluate(element => [...element.querySelectorAll('.attachment-timestamps dt, .attachment-timestamps time')].map(node => {
    const text = node.textContent ?? '';
    const visible: number[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let offset = 0;
    while (walker.nextNode()) {
      const current = walker.currentNode as Text;
      for (let i = 0; i < current.length; i++) {
        if (/\s/.test(current.data[i]!)) { visible.push(offset + i); continue; }
        const range = document.createRange(); range.setStart(current, i); range.setEnd(current, i + 1);
        const rect = range.getBoundingClientRect();
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
          if (style.overflowX !== 'visible') { left = Math.max(left, bounds.left + ancestor.clientLeft); right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth); }
          if (style.overflowY !== 'visible') { top = Math.max(top, bounds.top + ancestor.clientTop); bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight); }
        }
        if (rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1) visible.push(offset + i);
      }
      offset += current.length;
    }
    return { text, visible };
  }));
}

async function keyboardFocus(page: Page, target: Locator) {
  await target.focus();
  await expect(target).toBeFocused();
  // A programmatically focusable element alone is not necessarily in tab order.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

async function fullyUnclipped(target: Locator) {
  return target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
      if (style.overflowX !== 'visible') { left = Math.max(left, bounds.left + ancestor.clientLeft); right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth); }
      if (style.overflowY !== 'visible') { top = Math.max(top, bounds.top + ancestor.clientTop); bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight); }
    }
    return { left: rect.left - left, top: rect.top - top, right: right - rect.right, bottom: bottom - rect.bottom };
  });
}

for (const goal of [false, true]) for (const locale of ['en', 'zh-CN'] as const) for (const path of ['reading.txt', longPath]) {
  test(`compact ${goal ? 'Goal' : 'claimed Task'} exposes complete timestamps and reading by keyboard in ${locale}, ${path === longPath ? 'long' : 'short'} metadata`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 240 });
    const state = await install(page, false, !goal, undefined, goal);
    state.files = state.files.map(file => file.path === longPath ? { ...file, contentType: `text/plain; ${'long-mime-'.repeat(30)}` } : file);
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/${path.split('/').map(encodeURIComponent).join('/')}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const surface = page.locator('.task-detail-page'), outer = surface.locator('.task-detail-body');
    const header = surface.locator('.attachment-preview-header'), body = surface.locator('.attachment-preview-body:visible');
    await expect(header.locator('.attachment-timestamps dt')).toHaveText(locale === 'en' ? ['Created', 'Last modified'] : ['创建时间', '最后修改时间']);
    for (const value of await header.locator('.attachment-timestamps time').all()) await expect(value).toHaveAttribute('datetime', time);
    await expect(body.locator('pre')).toHaveText(longText);

    for (const rootSize of locale === 'en' && path === 'reading.txt' ? [12, 16, 24] : [24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
      await expect(header.locator('.attachment-timestamps')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
      for (const fullscreen of [false, true]) {
        if (fullscreen) await surface.locator('.task-detail-fullscreen-toggle').click();
        await keyboardFocus(page, outer);
        const outerDimensions = await outer.evaluate(element => ({ height: element.clientHeight, total: element.scrollHeight }));
        if (outerDimensions.total > outerDimensions.height + 1) {
          await page.keyboard.press('End');
          await expect.poll(() => outer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
          await page.waitForTimeout(250);
        }
        const seen = new Map<number, Set<number>>();
        let contents: Awaited<ReturnType<typeof visibleTimestampCharacters>> = [];
        await keyboardFocus(page, header);
        await page.keyboard.press('Home');
        await expect.poll(() => header.evaluate(element => element.scrollTop)).toBe(0);
        await page.waitForTimeout(250);
        for (let headerStep = 0; headerStep < 20; headerStep++) {
          const position = await header.evaluate(element => ({ top: element.scrollTop, end: element.scrollHeight - element.clientHeight }));
          await keyboardFocus(page, outer);
          await page.keyboard.press('End');
          await page.waitForTimeout(250);
          for (let outerStep = 0; outerStep < 30; outerStep++) {
            contents = await visibleTimestampCharacters(header);
            contents.forEach((item, index) => {
              const chars = seen.get(index) ?? new Set<number>();
              item.visible.forEach(char => chars.add(char)); seen.set(index, chars);
            });
            if (contents.every((item, index) => seen.get(index)?.size === item.text.length)) break;
            const top = await outer.evaluate(element => element.scrollTop);
            if (top <= 1) break;
            await page.keyboard.press('ArrowUp');
            await expect.poll(() => outer.evaluate(element => element.scrollTop)).toBeLessThan(top);
            await page.waitForTimeout(250);
          }
          if (contents.every((item, index) => seen.get(index)?.size === item.text.length)) break;
          if (position.top >= position.end - 1) break;
          await keyboardFocus(page, header);
          await page.keyboard.press('PageDown');
          await expect.poll(() => header.evaluate(element => element.scrollTop)).toBeGreaterThan(position.top);
          await page.waitForTimeout(250);
        }
        expect(contents).toHaveLength(4);
        contents.forEach((item, index) => expect(seen.get(index)?.size, `${item.text} at ${rootSize}px`).toBe(item.text.length));
        const download = header.getByRole('link', { name: locale === 'en' ? 'Download' : '下载', exact: true });
        const open = header.getByRole('link', { name: locale === 'en' ? 'Open in new tab' : '在新标签页打开' });
        for (const action of [download, open]) {
          await keyboardFocus(page, action);
          expect(Object.values(await fullyUnclipped(action)).every(distance => distance >= -1)).toBe(true);
          await expect(action).toHaveAttribute('href', /\S/);
        }
        await expect(download).toHaveAttribute('download', '');
        await expect(open).toHaveAttribute('target', '_blank');
        await keyboardFocus(page, body);
        expect(await body.evaluate(element => element.clientHeight)).toBeGreaterThan(0);
        await page.keyboard.press('End');
        await expect.poll(() => body.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
        if (fullscreen) await surface.locator('.task-detail-fullscreen-toggle').click();
      }
    }
    if (locale === 'en' && path === 'reading.txt') {
      await surface.getByRole('tab', { name: goal ? 'Description' : 'Overview', exact: true }).click();
      const tab = surface.getByRole('tab', { name: 'Attachments', exact: true });
      await tab.click();
      await expect(tab).toBeFocused();
      await expect(header.locator('h5')).toHaveAttribute('title', path);
      await keyboardFocus(page, header);
      await expect(body.locator('pre')).toHaveText(longText);
    }
    expect(state.writes).toEqual([]);
  });
}

for (const path of ['interactive.html', 'brief.pdf']) for (const wide of [false, true]) {
  test(`compact native ${path} actions remain reachable in ${wide ? 'a narrow container' : 'a short viewport'}`, async ({ page }) => {
    await page.setViewportSize(wide ? { width: 1360, height: 390 } : { width: 320, height: 240 });
    const state = await install(page, false, true);
    await page.route(`**/attachments/files/${path}`, route => route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': `attachment; filename="${path}"` }, body: 'fixture download' }));
    await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/${path}`);
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    const surface = page.locator('.task-detail-page'), attachments = surface.locator('.task-attachments');
    if (wide) await attachments.evaluate((element: HTMLElement) => { element.style.flex = 'none'; element.style.width = '320px'; });
    const header = surface.locator('.attachment-preview-header');
    const reload = header.getByRole('button', { name: 'Reload', exact: true });
    const download = header.getByRole('link', { name: 'Download', exact: true });
    const open = header.getByRole('link', { name: 'Open in new tab', exact: true });
    await expect(surface.locator('iframe')).toBeAttached();
    for (const action of [reload, download, open]) {
      await keyboardFocus(page, action);
      expect(Object.values(await fullyUnclipped(action)).every(distance => distance >= -1)).toBe(true);
    }
    const previous = state.requests.filter(request => request.path.endsWith(`/${path}`)).length;
    await keyboardFocus(page, reload);
    await page.keyboard.press('Enter');
    await expect.poll(() => state.requests.filter(request => request.path.endsWith(`/${path}`)).length).toBeGreaterThan(previous);
    await keyboardFocus(page, download);
    const [downloaded] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    expect(downloaded.suggestedFilename()).toBe(path);
    await keyboardFocus(page, open);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('Enter')]);
    await popup.close();
    expect(state.writes).toEqual([]);
  });
}

test('attachment timestamps and actions remain readable at actual 200% browser zoom', async ({ playwright }, info) => {
  const temporary = fileURLToPath(new URL('../../../../.tmp/attachment-browser-zoom/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  const profile = await mkdtemp(`${temporary}/profile-`);
  try {
    await mkdir(`${profile}/Default`);
    await writeFile(`${profile}/Default/Preferences`, JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
    const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
    const context = await playwright.chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, viewport: null, args: ['--window-size=1280,900', '--force-device-scale-factor=1'],
      ...(executable === undefined ? {} : { executablePath: executable }),
    });
    try {
      const page = await context.newPage();
      const state = await install(page, false, true);
      await page.goto(`http://127.0.0.1:4202/projects/${projectId}/tasks/${taskId}/attachments/reading.txt`);
      const zoom = await page.evaluate(() => ({ ratio: devicePixelRatio, width: innerWidth, cssZoom: getComputedStyle(document.documentElement).zoom, visualScale: visualViewport!.scale }));
      expect(zoom.ratio).toBeCloseTo(2, 1);
      expect(zoom.width).toBeLessThan(800);
      expect(zoom.cssZoom).toBe('1'); expect(zoom.visualScale).toBe(1);
      const header = page.locator('.attachment-preview-header');
      await expect(header.locator('.attachment-timestamps')).toHaveCSS('font-size', '12px');
      const items = header.locator('.attachment-timestamps dt, .attachment-timestamps time');
      await expect(items).toHaveCount(4);
      for (let index = 0; index < 4; index++) {
        await items.nth(index).scrollIntoViewIfNeeded();
        const item = (await visibleTimestampCharacters(header))[index]!;
        expect(item.visible.length, item.text).toBe(item.text.length);
      }
      for (const action of [header.getByRole('link', { name: 'Download', exact: true }), header.getByRole('link', { name: 'Open in new tab', exact: true })]) {
        await keyboardFocus(page, action);
        expect(Object.values(await fullyUnclipped(action)).every(distance => distance >= -1)).toBe(true);
      }
      const body = page.locator('.attachment-preview-body:visible');
      await keyboardFocus(page, body);
      await page.keyboard.press('End');
      await expect.poll(() => body.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
      expect(state.writes).toEqual([]);
      await info.attach('attachment-browser-200-percent-zoom', { body: JSON.stringify(zoom), contentType: 'application/json' });
    } finally { await context.close(); }
  } finally { await rm(profile, { recursive: true, force: true }); }
});

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
    expect(await body.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop + element.clientHeight >= element.scrollHeight - 1; })).toBe(true);
    await dialog.getByRole('button', { name: 'Close task details', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }))).toEqual(before);
    expect(state.writes).toEqual([]);
  });
}

test('native HTML preview preserves frame ownership and returns focus after closing', async ({ page }) => {
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
  await dialog.locator('.task-detail-fullscreen-toggle').click();
  await expect(dialog).not.toHaveClass(/task-detail-fullscreen/);
  await expect(counter).toHaveText('1');
  expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
  expect(state.resources.filter(path => path.endsWith('/interactive.html')).length).toBe(reads);
  await dialog.getByRole('button', { name: 'Close task details', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await frameHandle!.dispose(); await inputHandle!.dispose();
  expect(state.writes).toEqual([]);
});

test('native document navigations use the Task host and reload the current URL after a transport failure', async ({ page }) => {
  const state = await install(page);
  let fail = true;
  const navigations: { method: string; origin: string; path: string }[] = [];
  await page.route('**/preview/interactive.html', route => {
    const request = route.request(), url = new URL(request.url());
    navigations.push({ method: request.method(), origin: url.origin, path: url.pathname });
    if (fail) { fail = false; return route.abort('failed'); }
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  const { attachments } = await openDialog(page);
  await attachments.getByRole('button', { name: /^interactive\.html/ }).click();
  await expect.poll(() => navigations.length).toBe(1);
  const reload = attachments.getByRole('button', { name: 'Reload', exact: true });
  await expect(reload).toBeVisible();
  await reload.click();
  await expect(attachments.locator('iframe').contentFrame().locator('#counter')).toHaveText('0');
  await expect.poll(() => navigations.length).toBe(2);
  expect(navigations).toEqual([1, 2].map(() => ({ method: 'GET', origin: `http://${taskId}.preview.localhost:8787`, path: `${root}/preview/interactive.html` })));
  expect(state.requests.filter(request => request.path.endsWith('/interactive.html'))).toEqual([]);
});

for (const mode of ['dialog', 'reader'] as const) {
  for (const timestamp of ['same', 'changed'] as const) {
    test(`native overwrite rebuilds exactly once with ${timestamp} timestamp in ${mode}`, async ({ page }) => {
      const state = await install(page);
      const item = state.files.find(file => file.path === 'interactive.html')!;
      const updated = { ...item, updatedAt: timestamp === 'same' ? item.updatedAt : '2026-10-21T09:00:00Z' };
      const inventory = Promise.withResolvers<void>();
      let listReads = 0, content = 'Before overwrite', gets = 0;
      await page.route(url => url.pathname === `${root}/attachments`, async route => {
        if (++listReads > 1) await inventory.promise;
        await route.fulfill({ contentType: 'application/json', body: stringifyWireJson({ items: listReads > 1 ? state.files.map(file => file.path === item.path ? updated : file) : state.files, nextCursor: null }), headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
      });
      await page.route('**/attachments/files/interactive.html', route => {
        content = 'After overwrite';
        return route.fulfill({ status: 201, contentType: 'application/json', body: stringifyWireJson(updated), headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
      });
      await page.route('**/preview/interactive.html', route => {
        gets++;
        return route.fulfill({ contentType: 'text/html', body: `<p>${content}</p>` });
      });
      try {
        const attachments = mode === 'dialog' ? (await openDialog(page)).attachments : (await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/interactive.html`), page.locator('.task-attachments'));
        if (mode === 'dialog') await attachments.getByRole('button', { name: /^interactive\.html/ }).click();
        const frame = attachments.locator('iframe');
        await expect(frame.contentFrame().getByText('Before overwrite')).toBeVisible();
        const original = await frame.elementHandle();
        await attachments.locator('.attachment-upload-disclosure summary').click();
        await attachments.locator('input[type=file]').setInputFiles({ name: 'interactive.html', mimeType: 'text/html', buffer: Buffer.from('new content') });
        await attachments.getByRole('button', { name: 'Upload file', exact: true }).click();
        await expect(frame.contentFrame().getByText('After overwrite')).toBeVisible();
        await expect.poll(() => listReads).toBe(2);
        expect(gets).toBe(2);
        const replaced = await frame.elementHandle();
        expect(await original!.evaluate(element => element.isConnected)).toBe(false);
        inventory.resolve();
        await expect(attachments.getByRole('button', { name: 'Refresh attachments' })).toBeEnabled();
        expect(await replaced!.evaluate(element => element.isConnected)).toBe(true);
        expect(gets).toBe(2);
        await original!.dispose(); await replaced!.dispose();
      } finally { inventory.resolve(); }
    });
  }
}

for (const entry of ['detail', 'reader'] as const) {
  for (const filename of ['interactive.html', 'brief.pdf'] as const) {
    test(`Goal ${entry} directly requests ${filename} from its Task host`, async ({ page }) => {
      const state = await install(page, false, false, undefined, true);
      if (entry === 'reader') await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/${filename}`);
      else {
        await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=attachments`);
        await page.locator('.task-attachments').getByRole('button', { name: new RegExp(`^${filename.replace('.', '\\.')}`) }).click();
      }
      const frame = page.locator('.task-attachments iframe');
      await expect(frame).toHaveAttribute('src', `http://${taskId}.preview.localhost:8787${root}/preview/${filename}`);
      if (filename.endsWith('.html')) await expect(frame.contentFrame().locator('#counter')).toHaveText('0');
      else await expect.poll(async () => hasPaintedPdfMarker(await page.evaluate(readPdfPixels, (await frame.screenshot()).toString('base64'))), { timeout: 20_000 }).toBe(true);
      expect(state.requests.filter(request => request.path.endsWith(`/${filename}`))).toEqual([{ method: 'GET', origin: `http://${taskId}.preview.localhost:8787`, path: `${root}/preview/${filename}` }]);
    });
  }
}

for (const item of [{ path: 'interactive.html', type: 'text/html', body: html }, { path: 'brief.pdf', type: 'application/pdf', body: pdf }]) {
  test(`embedded ${item.path} exposes a document error and retries the same URL`, async ({ page }) => {
    await install(page);
    const requests: string[] = [];
    await page.route(`**/preview/${item.path}`, route => {
      requests.push(route.request().url());
      if (requests.length === 1) return route.fulfill({ status: 403, contentType: 'text/html', body: '<h1>Preview unavailable</h1><p>Request ID: fixture-request</p><a id="retry" href="">Retry preview</a>' });
      return route.fulfill({ contentType: item.type, body: item.body });
    });
    const { attachments } = await openDialog(page);
    await attachments.getByRole('button', { name: new RegExp(`^${item.path.replace('.', '\\.')}`) }).click();
    const frame = attachments.locator('iframe');
    await expect(frame.contentFrame().getByText('Request ID: fixture-request')).toBeVisible();
    await frame.contentFrame().getByRole('link', { name: 'Retry preview' }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toBe(requests[0]);
    if (item.path.endsWith('.html')) await expect(frame.contentFrame().locator('#counter')).toHaveText('0');
    else await expect.poll(async () => hasPaintedPdfMarker(await page.evaluate(readPdfPixels, (await frame.screenshot()).toString('base64'))), { timeout: 20_000 }).toBe(true);
  });
}

for (const viewport of [{ width: 1440, height: 800 }, { width: 320, height: 800 }, { width: 320, height: 240 }, { width: 844, height: 390 }]) {
  for (const locale of ['en', 'zh-CN'] as const) {
    test(`native reload is visible and keyboard reachable at ${viewport.width}x${viewport.height} (${locale})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await install(page);
      await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
      await page.goto(`/projects/${projectId}/tasks/${taskId}/attachments/interactive.html`);
      const reload = page.getByRole('button', { name: locale === 'en' ? 'Reload' : '重新加载', exact: true });
      const download = page.getByRole('link', { name: locale === 'en' ? 'Download' : '下载', exact: true });
      const open = page.getByRole('link', { name: locale === 'en' ? 'Open in new tab' : '在新标签页打开', exact: true });
      for (const action of [reload, download, open]) {
        await expect(action).toBeVisible();
        await expect(action).toBeInViewport({ ratio: 1 });
      }
      await reload.focus();
      await expect(reload).toBeFocused();
      await page.keyboard.press('Tab'); await expect(download).toBeFocused();
      await page.keyboard.press('Tab'); await expect(open).toBeFocused();
      const boxes = await page.locator('.attachment-preview-header').evaluate(header => {
        const bounds = (selector: string) => [...header.querySelectorAll(selector)].map(element => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        });
        return { actions: bounds('.attachment-preview-actions .button'), times: bounds('.attachment-timestamps dt, .attachment-timestamps time') };
      });
      expect(boxes.actions).toHaveLength(3);
      expect(boxes.times).toHaveLength(4);
      for (const action of boxes.actions) for (const time of boxes.times) {
        expect(action.right <= time.left || time.right <= action.left || action.bottom <= time.top || time.bottom <= action.top).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test('preserves an interactive HTML document before its pending subresource finishes', async ({ page }) => {
  const state = await install(page);
  const imageGate = Promise.withResolvers<void>();
  const imageStarted = Promise.withResolvers<void>();
  await page.route('**/preview/slow.png', async route => {
    imageStarted.resolve();
    await imageGate.promise;
    await route.fulfill({ body: svg, headers: { 'Content-Type': 'image/svg+xml' } }).catch(() => undefined);
  });
  await page.route('**/preview/interactive.html', route => route.fulfill({
    body: route.request().method() === 'HEAD' ? '' : '<!doctype html><html><body><label>Draft <input></label><img src="slow.png"></body></html>',
    headers: { 'Content-Type': 'text/html', 'Daynight-User-ID': TEST_VIEWER_ID },
  }));
  const { attachments } = await openDialog(page);
  try {
    await attachments.getByRole('button', { name: /^interactive\.html/ }).click();
    const frame = attachments.locator('iframe');
    const input = frame.contentFrame().getByRole('textbox', { name: 'Draft' });
    await imageStarted.promise;
    await input.fill('unsaved');
    expect(await input.evaluate(element => element.ownerDocument.readyState)).not.toBe('complete');
    const originalFrame = await frame.elementHandle();
    const originalInput = await input.elementHandle();
    await checkDuringForeground(page, state, async () => {
      expect(await originalFrame!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
      expect(await originalInput!.evaluate(element => element === document.querySelector('input'))).toBe(true);
      await expect(input).toHaveValue('unsaved');
    });
    await originalInput!.dispose();
    await originalFrame!.dispose();
  } finally { imageGate.resolve(); }
});

test('foreground return preserves actual text selection and preview scroll', async ({ page }) => {
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
  await checkDuringForeground(page, state, async () => {
    await expect(dialog).toBeVisible(); await expect(pre).toHaveText(longText);
    expect(await body.evaluate(element => element.scrollTop)).toBe(top);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Line 1');
  });
  expect(state.writes).toEqual([]);
});

// The colored rectangle is part of the small source PDF. Checking its actual
// pixels distinguishes a rendered page from an iframe that merely loaded.
test('native PDF preview paints its document in the browser', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await install(page);
  const { attachments } = await openDialog(page);
  await attachments.getByRole('button', { name: /^brief\.pdf/ }).click();
  const frame = attachments.locator('iframe');
  await expect(frame).toBeVisible();
  await expect.poll(async () => {
    const png = await frame.screenshot({ animations: 'disabled' });
    return hasPaintedPdfMarker(await page.evaluate(readPdfPixels, png.toString('base64')));
  }, { message: 'PDF preview paints the fixture rectangle', timeout: 20_000, intervals: [100, 250, 500] }).toBe(true);
  expect(state.requests.filter(request => request.path.endsWith('/brief.pdf'))).toEqual([{ method: 'GET', origin: `http://${taskId}.preview.localhost:8787`, path: `${root}/preview/brief.pdf` }]);
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
    await expect(attachments.getByRole('link', { name: 'Vector file' })).toHaveAttribute('href', `http://${taskId}.preview.localhost:8787${root}/preview/icon.svg`);
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

test('standalone loaded HTML retains its frame and draft through fullscreen changes', async ({ page }) => {
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
  await surface.locator('.task-detail-fullscreen-toggle').click();
  await expect(surface).not.toHaveClass(/task-detail-fullscreen/);
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
  await checkDuringForeground(page, state, async () => {
    expect(await handle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    await expect(counter).toHaveText('1'); expect(await html.evaluate(element => element.scrollTop)).toBe(top);
    expect(state.resources.filter(path => path.endsWith('/interactive.html')).length).toBe(reads);
  });
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
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=(overview|tasks|prs|tags)$`));
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
