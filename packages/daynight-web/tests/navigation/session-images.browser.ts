import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openSessionImages } from '../helpers/sessionImageBrowser';

for (const entry of ['task', 'test', 'task-dialog'] as const) test(`${entry} uses the shared native image dialog without changing its outer surface`, async ({ page }, info) => {
  const fixture = await openSessionImages(page, { entry });
  const formats = entry === 'task' ? ['png', 'jpeg', 'gif', 'webp', 'avif'] : ['png'];
  const measurements = [], timeline = page.locator('.session-timeline');
  await timeline.hover(); await page.mouse.wheel(0, -5000);
  for (const format of formats) {
    const label = `Example.${format}`, trigger = page.getByRole('button', { name: `View image: ${label}`, exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await expect.poll(() => trigger.locator('img').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).naturalWidth))).toEqual([3]);
    const geometry = await trigger.locator('img').evaluate(image => ({ key: image.getAttribute('data-media-key'), width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, frameWidth: image.parentElement!.getBoundingClientRect().width }));
    expect(geometry.key).toBeTruthy(); expect(geometry.width).toBe(3); expect(geometry.height).toBe(2); expect(geometry.frameWidth).toBeLessThanOrEqual(420);
    const scrollTop = await timeline.evaluate(node => node.scrollTop);
    await trigger.click();
    const dialog = page.locator('dialog.session-image-preview'); await expect(dialog).toBeVisible();
    await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 3);
    expect(await dialog.evaluate(node => !!node.closest('.task-agent-session') && !node.closest('.session-timeline'))).toBe(true);
    const close = dialog.getByRole('button', { name: 'Close image preview' }); await expect(close).toBeFocused();
    await expect(timeline).toHaveAttribute('data-image-preview-locked', 'true');
    await dialog.locator('.session-image-preview-stage').hover(); await page.mouse.wheel(0, 500); expect(await timeline.evaluate(node => node.scrollTop)).toBe(scrollTop);
    await close.focus(); await page.keyboard.press('Shift+Tab'); await expect(dialog.locator('.session-image-preview-stage')).toBeFocused(); await page.keyboard.press('Tab'); await expect(close).toBeFocused();
    const promise = page.waitForEvent('download'); await dialog.getByRole('button', { name: `Download image: ${label}` }).click(); const download = await promise;
    const destination = info.outputPath(`download-${format}`); await download.saveAs(destination);
    expect(createHash('sha256').update(await readFile(destination)).digest('hex')).toBe(fixture.resources.find(resource => resource.name === label)!.sha256);
    const resourceId = fixture.resources.find(resource => resource.name === label)!.resourceId, readCount = () => fixture.observations.resources.filter(id => id === resourceId).length, reads = readCount(); await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
    expect(await timeline.evaluate(node => node.scrollTop)).toBe(scrollTop);
    await trigger.click(); await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 3); expect(readCount()).toBe(reads); await page.keyboard.press('Escape');
    let refreshReads: number | null = null;
    if (entry === 'task' && format === 'png') {
      const image = await trigger.locator('img').elementHandle(), beforeCurrent = fixture.observations.currentReads, beforeReads = readCount();
      await page.locator('.session-header').getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect.poll(() => fixture.observations.currentReads).toBeGreaterThan(beforeCurrent);
      // This marker is delivered only by the refreshed HTTP history response.
      await expect(page.getByText(/^History refresh \d+$/)).toBeAttached();
      expect(await trigger.locator('img').evaluate((node, previous) => node === previous, image)).toBe(true);
      refreshReads = readCount() - beforeReads; expect(refreshReads).toBe(0);
    }
    measurements.push({ format, ...geometry, repeatedPreviewReads: 0, refreshReads, download: download.suggestedFilename() });
  }
  const fullscreen = page.locator('.session-fullscreen-toggle'); await fullscreen.click(); await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  const trigger = page.getByRole('button', { name: 'View image: Example.png', exact: true }); await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await expect(page.locator('dialog.session-image-preview')).toBeVisible(); await page.keyboard.press('Escape'); await expect(fullscreen).toHaveAttribute('aria-pressed', 'true'); await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape'); await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
  if (entry === 'task-dialog') {
    const outer = page.locator('.task-detail-dialog'); await expect(outer).toBeVisible(); await outer.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await trigger.scrollIntoViewIfNeeded(); await trigger.click(); await page.keyboard.press('Escape'); await expect(outer.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  }
  expect(fixture.observations.writes).toEqual([]); expect(fixture.observations.pageErrors).toEqual([]);
  await info.attach('image-evidence', { body: JSON.stringify({ boundary: 'Production App and image renderer with HTTP/WebSocket fixtures; real Chrome decoding and downloads. No real service or Provider.', entry, measurements, observations: fixture.observations }), contentType: 'application/json' });
});

test('linked Markdown retains its link while image actions fit a 390px page', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); const fixture = await openSessionImages(page);
  const link = page.locator('a[href="https://example.com/report"]'); await link.scrollIntoViewIfNeeded();
  await expect(link).toHaveAttribute('href', 'https://example.com/report'); await expect(link.locator('img')).toHaveJSProperty('naturalWidth', 3); await expect(link.locator('button')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'View image: Linked image', exact: true });
  expect(await trigger.evaluate(node => !node.closest('a'))).toBe(true); await trigger.click();
  const dialog = page.locator('dialog.session-image-preview'); await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 3);
  for (const button of await dialog.getByRole('button').all()) { const box = await button.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
  await page.screenshot({ path: info.outputPath('linked-image-390.png') }); await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  expect(fixture.observations.writes).toEqual([]); expect(fixture.observations.pageErrors).toEqual([]);
});

test('large originals preserve the media anchor and scroll inside a narrow stage', async ({ page }, info) => {
  const fixture = await openSessionImages(page, { dimensions: [1800, 1200], longLabel: true });
  const label = fixture.resources[0]!.name, trigger = page.getByRole('button', { name: `View image: ${label}`, exact: true });
  const timeline = page.locator('.session-timeline'); await timeline.hover(); await page.mouse.wheel(0, -5000); await trigger.scrollIntoViewIfNeeded();
  await expect(trigger.locator('img')).toHaveJSProperty('naturalWidth', 1800);
  const content = trigger.locator('img');
  await timeline.evaluate(node => { const image = node.querySelector('img')!; node.scrollTop += image.getBoundingClientRect().top + image.getBoundingClientRect().height / 2 - node.getBoundingClientRect().top; node.dispatchEvent(new Event('scroll')); });
  const normalized = () => content.evaluate(image => { const timeline = image.closest('.session-timeline')!, rect = image.getBoundingClientRect(); return (timeline.getBoundingClientRect().top - rect.top) / rect.height; });
  await expect.poll(normalized).toBeCloseTo(0.5, 1);
  const originalNormalized = await normalized();
  const anchorError = () => content.evaluate((image, saved) => { const timeline = image.closest('.session-timeline')!, rect = image.getBoundingClientRect(); return rect.top + rect.height * saved - timeline.getBoundingClientRect().top; }, originalNormalized);
  await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(async () => Math.abs(await anchorError())).toBeLessThanOrEqual(2);
  const mediaAnchor = { originalNormalized, afterNormalized: await normalized(), errorCssPixels: await anchorError() };
  await info.attach('media-reading-anchor', { body: JSON.stringify(mediaAnchor), contentType: 'application/json' });
  await trigger.click(); const dialog = page.locator('dialog.session-image-preview'); await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 1800);
  await dialog.getByRole('button', { name: 'Original size' }).click(); const stage = dialog.locator('.session-image-preview-stage');
  await stage.evaluate(node => { node.scrollTop = 321; node.scrollLeft = 123; }); expect(await stage.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }))).toEqual({ top: 321, left: 123 });
  await stage.focus(); await page.keyboard.press('End'); expect(await stage.evaluate(node => node.scrollTop > 321)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await dialog.getByRole('button').all()) { const box = await button.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44); }
  await page.screenshot({ path: info.outputPath('large-original-390.png') }); await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  expect(fixture.observations.writes).toEqual([]); expect(fixture.observations.pageErrors).toEqual([]);
});

test('extreme tall images keep a 320px frame without clipping the original', async ({ page }) => {
  const fixture = await openSessionImages(page, { dimensions: [24, 1200] }); const trigger = page.getByRole('button', { name: 'View image: Example.png', exact: true });
  await page.locator('.session-timeline').hover(); await page.mouse.wheel(0, -5000); await trigger.scrollIntoViewIfNeeded(); await expect(trigger.locator('img')).toHaveJSProperty('naturalHeight', 1200);
  const rect = await trigger.locator('img').evaluate(image => ({ image: { width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height }, canvas: { width: image.parentElement!.getBoundingClientRect().width, height: image.parentElement!.getBoundingClientRect().height } }));
  expect(rect.canvas.width).toBeLessThanOrEqual(420); expect(rect.canvas.height).toBeLessThanOrEqual(320); expect(rect.image.height).toBeLessThanOrEqual(rect.canvas.height); expect(rect.image.width / rect.image.height).toBeCloseTo(24 / 1200, 2);
  await trigger.click(); await expect(page.locator('dialog img')).toHaveJSProperty('naturalHeight', 1200); expect(fixture.observations.pageErrors).toEqual([]);
});


test('prepending earlier text preserves the original first entry within one CSS pixel', async ({ page }, info) => {
  const fixture = await openSessionImages(page, { prepend: true }), timeline = page.locator('.session-timeline');
  try {
    await timeline.hover(); await page.mouse.wheel(0, -100000);
    await expect.poll(() => fixture.observations.beforeReads).toBe(1);
    await expect(page.getByText('Loading earlier activity…', { exact: true })).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const original = timeline.locator(`[data-entry-key="${fixture.entries[0]!.entryId}"]`);
    const offset = () => original.evaluate(node => node.getBoundingClientRect().top - node.closest('.session-timeline')!.getBoundingClientRect().top);
    const before = await offset(); fixture.releaseBefore();
    await expect(page.locator('.session-entry')).toHaveCount(fixture.entries.length + fixture.older.length);
    await expect(page.getByText('Loading earlier activity…', { exact: true })).toHaveCount(0);
    await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThanOrEqual(1);
    const after = await offset();
    await info.attach('text-prepend-anchor', { body: JSON.stringify({ before, after, errorCssPixels: after - before, beforeReads: fixture.observations.beforeReads, boundary: 'Production App HTTP before-page response with real Chrome layout and wheel input.' }), contentType: 'application/json' });
    expect(fixture.observations.resources).toEqual([]); expect(fixture.observations.writes).toEqual([]); expect(fixture.observations.pageErrors).toEqual([]);
  } finally { fixture.releaseBefore(); }
});


test('tool image output decodes after expansion and survives collapse and display filtering from one original', async ({ page }, info) => {
  const fixture = await openSessionImages(page, { tool: true }), resource = fixture.resources.find(item => item.name === 'Tool output.png')!;
  const reads = () => fixture.observations.resources.filter(id => id === resource.resourceId).length;
  const details = page.locator('.session-tool').filter({ hasText: 'inspect_image' }), summary = details.locator('summary');
  await summary.scrollIntoViewIfNeeded(); expect(reads()).toBe(0); await summary.click();
  const trigger = page.getByRole('button', { name: `View image: ${resource.name}`, exact: true });
  await expect(trigger.locator('img')).toHaveJSProperty('naturalWidth', 3); expect(reads()).toBe(1);
  await trigger.click(); const preview = page.locator('dialog.session-image-preview'); await expect(preview.locator('img')).toHaveJSProperty('naturalHeight', 2);
  const pending = page.waitForEvent('download'); await preview.getByRole('button', { name: `Download image: ${resource.name}`, exact: true }).click(); const download = await pending;
  const destination = info.outputPath('tool-original.png'); await download.saveAs(destination); const sha256 = createHash('sha256').update(await readFile(destination)).digest('hex'); expect(sha256).toBe(resource.sha256);
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await summary.click(); await expect(trigger).toHaveCount(0); await summary.click(); await expect(trigger.locator('img')).toHaveJSProperty('naturalWidth', 3);
  const display = page.getByRole('button', { name: 'Display', exact: true }); await display.click(); await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click(); await page.keyboard.press('Escape'); await expect(details).toHaveCount(0);
  await display.click(); await page.getByRole('menuitemradio', { name: 'Standard', exact: true }).click(); await page.keyboard.press('Escape'); await expect(details).toHaveAttribute('open', ''); await trigger.scrollIntoViewIfNeeded(); await expect(trigger.locator('img')).toHaveJSProperty('naturalWidth', 3);
  expect(reads()).toBe(1); expect(fixture.observations.writes).toEqual([]); expect(fixture.observations.pageErrors).toEqual([]);
  await info.attach('tool-image-evidence', { body: JSON.stringify({ sha256, originalReads: reads(), naturalWidth: 3, naturalHeight: 2, restoredExpandedState: true, boundary: 'Production tool Timeline renderer with controlled saved original; real Chrome decode and download.' }), contentType: 'application/json' });
});
