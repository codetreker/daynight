import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installPrList, projectId, records, type Scene } from './pr-list-fixture';

const open = async (page: Page) => {
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-prs').click();
  await expect(page.locator('.pr-row')).toHaveCount(6);
};
const capture = async (page: Page, info: TestInfo, name: string) => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
};
const assertFits = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const content = page.locator('#project-section-panel-prs');
  const box = await content.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
};

for (const width of [1440, 800, 390, 320]) test(`production project navigation, list and detail fit ${width}px`, async ({ page }, info) => {
  const state = await installPrList(page);
  state.graphFailure = true;
  await page.setViewportSize({ width, height: 900 });
  await open(page);
  await assertFits(page);
  const overview = page.locator('#project-section-tab-overview'), tasks = page.locator('#project-section-tab-tasks'), prs = page.locator('#project-section-tab-prs');
  await expect(prs).toHaveAttribute('aria-selected', 'true');
  const boxes = await Promise.all([overview, tasks, prs].map(item => item.boundingBox()));
  if (width > 740) {
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
    expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
  } else {
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
  }
  await prs.focus();
  await page.keyboard.press('Home'); await expect(overview).toBeFocused();
  await page.keyboard.press(width > 740 ? 'ArrowDown' : 'ArrowRight'); await expect(tasks).toBeFocused();
  await expect(page.locator('#project-section-panel-tasks')).toContainText('pr-list-fixture');
  await page.keyboard.press('End'); await expect(page.locator('#project-section-tab-tags')).toBeFocused();
  await page.keyboard.press(width > 740 ? 'ArrowUp' : 'ArrowLeft'); await expect(prs).toBeFocused();
  await expect(page.locator('.pr-row')).toHaveCount(6);
  await expect(page.locator('#project-section-panel-prs').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.pr-row').filter({ hasText: 'Draft' })).toHaveCount(2);
  await capture(page, info, `pr-list-${width}`);
  const row = page.locator('.pr-row').first();
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: records[0]!.title })).toBeVisible();
  await assertFits(page);
  const raw = dialog.getByRole('checkbox', { name: 'Raw Markdown' });
  await raw.check(); await expect(raw).toBeChecked();
  await expect(dialog.locator('pre')).toContainText('Paragraph 40');
  await capture(page, info, `pr-detail-${width}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(row).toBeFocused();
  expect(state.unexpected).toEqual([]);
});

test('all 48 summaries are reachable with server cursors, filters and page state survive section history', async ({ page }) => {
  const state = await installPrList(page);
  await open(page);
  const panel = page.locator('#project-section-panel-prs'), filter = panel.locator('.pr-toolbar select'), search = panel.locator('.pr-toolbar input');
  await filter.selectOption('all');
  await expect(panel).toContainText('48');
  const seen: string[] = [];
  for (let index = 0; index < 8; index++) {
    await expect(page.locator('.pr-row').first()).toContainText(`#${1248 - index * 6}`);
    seen.push(...await page.locator('.pr-row-number').allTextContents());
    if (index < 7) await panel.getByRole('button', { name: /^Next$/i }).click();
  }
  expect(seen).toEqual(records.map(item => `#${item.number}`));
  await expect(panel.getByRole('button', { name: /^Next$/i })).toBeDisabled();
  await panel.getByRole('button', { name: /^Previous$/i }).click();
  await expect(page.locator('.pr-row').first()).toContainText('#1212');
  await page.locator('#project-section-tab-tasks').click();
  await page.goBack();
  await expect(page.locator('#project-section-tab-prs')).toHaveAttribute('aria-selected', 'true');
  await expect(filter).toHaveValue('all');
  await expect(page.locator('.pr-row').first()).toContainText('#1212');
  await page.goForward();
  await expect(page.locator('#project-section-tab-tasks')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#project-section-tab-prs').click();
  await expect(page.locator('.pr-row').first()).toContainText('#1212');
  await filter.selectOption('merged');
  await expect(page.locator('.pr-row').first()).toContainText('#1236');
  await search.fill('1234');
  await expect(page.locator('.pr-row')).toHaveCount(1);
  await expect(page.locator('.pr-row')).toContainText('#1234');
  await search.fill('no matching title');
  await expect(page.locator('.pr-row')).toHaveCount(0);
  await expect(panel).toContainText(/No matching|No pull requests match/i);
  await search.fill('');
  await expect(page.locator('.pr-row')).toHaveCount(6);
  expect(state.pageReads.some(query => query.includes('cursor=opaque'))).toBe(true);
  expect(state.detailReads).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test('background reconciliation retains the real dialog, raw choice, focus and reading position', async ({ page }) => {
  const state = await installPrList(page);
  await page.clock.install();
  await open(page);
  await page.locator('.pr-row').first().click();
  const dialog = page.getByRole('dialog'), raw = dialog.getByRole('checkbox', { name: 'Raw Markdown' });
  await expect(dialog.getByRole('heading', { name: records[0]!.title })).toBeVisible();
  await raw.check();
  const body = dialog.locator('.dialog-body');
  const position = await body.evaluate(element => { element.scrollTop = Math.floor(element.scrollHeight / 2); return element.scrollTop; });
  expect(position).toBeGreaterThan(0);
  await dialog.evaluate(element => element.setAttribute('data-reading-witness', 'retained'));
  state.revision++;
  await page.clock.fastForward(15_100);
  await expect(dialog.getByRole('heading', { name: `${records[0]!.title} updated`, exact: true })).toBeVisible();
  await expect(dialog).toHaveAttribute('data-reading-witness', 'retained');
  await expect(raw).toBeChecked(); await expect(raw).toBeFocused();
  expect(await body.evaluate(element => element.scrollTop)).toBe(position);
  expect(state.detailReads).toBeGreaterThan(1);
  await page.goBack();
  await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.pr-detail-dialog')).toHaveCount(1);
  await expect(page.locator('.pr-detail-dialog')).not.toBeVisible();
  await page.goForward();
  await expect(dialog).toHaveAttribute('data-reading-witness', 'retained');
  await expect(raw).toBeChecked();
  expect(await body.evaluate(element => element.scrollTop)).toBe(position);
  expect(state.unexpected).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 320]) {
  test(`sync off and unavailable service show one primary notice at ${width}px in ${locale}`, async ({ page }, info) => {
    const state = await installPrList(page, locale);
    state.syncOff = true;
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const notice = page.locator('.pr-sync-status .pr-status-note');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(locale === 'en'
      ? 'Sync is off. Saved pull requests remain readable but will not be updated.'
      : '同步已关闭，已有 PR 仍可读取，暂不会更新。');
    const link = notice.getByRole('link', { name: locale === 'en' ? 'View sync settings' : '查看同步设置' });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', `/projects/${projectId}/settings`);
    await assertFits(page);
    await capture(page, info, `sync-off-${locale}-${width}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings$`));
    expect(state.unexpected.filter(request => !request.startsWith('GET '))).toEqual([]);
  });
}

test('a background sync status change preserves filtering, pagination and the open reading position', async ({ page }) => {
  const state = await installPrList(page);
  await page.clock.install();
  await open(page);
  const panel = page.locator('#project-section-panel-prs');
  const filter = panel.locator('.pr-toolbar select'), search = panel.locator('.pr-toolbar input');
  await filter.selectOption('all');
  await search.fill('Pull request');
  await expect(page.locator('.pr-row')).toHaveCount(6);
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.pr-row').first()).toContainText('#1241');
  await page.locator('.pr-row').first().click();
  const dialog = page.getByRole('dialog'), raw = dialog.getByRole('checkbox', { name: 'Raw Markdown' });
  await raw.check();
  const body = dialog.locator('.dialog-body');
  const position = await body.evaluate(element => { element.scrollTop = Math.floor(element.scrollHeight / 2); return element.scrollTop; });
  expect(position).toBeGreaterThan(0);
  await dialog.evaluate(element => element.setAttribute('data-reading-witness', 'retained'));
  const reads = state.statusReads;
  state.syncOff = true;
  await page.clock.fastForward(15_100);
  await expect.poll(() => state.statusReads).toBeGreaterThan(reads);
  await expect(panel.locator('.pr-sync-status .pr-status-note')).toContainText('Sync is off.');
  await expect(dialog).toHaveAttribute('data-reading-witness', 'retained');
  await expect(raw).toBeChecked(); await expect(raw).toBeFocused();
  expect(await body.evaluate(element => element.scrollTop)).toBe(position);
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue('all'); await expect(search).toHaveValue('Pull request');
  await expect(page.locator('.pr-row').first()).toContainText('#1241');
  expect(state.unexpected).toEqual([]);
});

test('independent PR empty, connection and saved-data notices remain readable at phone width', async ({ page }, info) => {
  const state = await installPrList(page);
  await page.setViewportSize({ width: 320, height: 800 });
  const cases: readonly [Scene, RegExp][] = [
    ['notconnected', /not connected|connect GitHub/i], ['initial', /initial|first sync/i], ['empty', /No pull requests|No PRs/i],
    ['read-error', /Could not|failed/i], ['stale', /saved|retry|failed/i], ['unavailable', /unavailable/i], ['disconnected', /disconnected/i],
  ];
  for (const [scene, text] of cases) {
    state.scene = scene;
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-prs').click();
    const panel = page.locator('#project-section-panel-prs');
    await expect(panel).toContainText(text);
    await assertFits(page);
    if (['notconnected', 'initial', 'read-error'].includes(scene)) {
      for (const option of await panel.locator('.pr-toolbar select option').allTextContents()) expect(option).not.toMatch(/\b0\b/);
    }
    if (['stale', 'unavailable', 'disconnected'].includes(scene)) await expect(page.locator('.pr-row')).toHaveCount(6);
    await capture(page, info, `pr-scene-${scene}`);
  }
  expect(state.unexpected).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 768, 390, 320]) {
  test(`PR filter arrow and native selection at ${width}px in ${locale}`, async ({ page }, info) => {
    const state = await installPrList(page, locale);
    state.longCounts = true;
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const filter = page.getByRole('combobox', { name: locale === 'en' ? 'Pull request status' : 'PR 状态' });
    const arrow = page.locator('.pr-filter-wrap .native-select__arrow');
    await expect(arrow).toHaveAttribute('aria-hidden', 'true');
    await expect(arrow.locator('path')).toHaveAttribute('d', 'm2 3.5 3 3 3-3');
    await expect(filter.locator('option')).toHaveCount(4);
    for (const value of ['active', 'merged', 'closed', 'all']) {
      await filter.selectOption(value);
      await expect(filter).toHaveValue(value);
      const geometry = await filter.evaluate((element) => {
        const select = element as HTMLSelectElement, rect = select.getBoundingClientRect();
        const icon = select.parentElement!.querySelector('svg')!, box = icon.getBoundingClientRect();
        const style = getComputedStyle(select), canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return { right: rect.right - box.right, center: (rect.top + rect.bottom - box.top - box.bottom) / 2,
          width: box.width, height: box.height, selectHeight: rect.height, appearance: style.appearance,
          textWidth: context.measureText(select.selectedOptions[0]!.textContent!).width,
          available: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2,
          hitSelect: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === select };
      });
      expect(geometry.right).toBeCloseTo(12, 0);
      expect(Math.abs(geometry.center)).toBeLessThanOrEqual(1);
      expect([geometry.width, geometry.height, geometry.selectHeight, geometry.appearance]).toEqual([10, 10, 32, 'none']);
      expect(geometry.textWidth).toBeLessThanOrEqual(geometry.available + 1);
      expect(geometry.hitSelect).toBe(true);
      await assertFits(page);
    }
    await filter.selectOption('active');
    const box = (await arrow.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(filter).toBeFocused();
    await expect.poll(() => filter.evaluate(element => element.matches(':open'))).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(filter).toHaveValue('merged');
    await page.keyboard.press('Tab');
    await expect(page.locator('#pr-search')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(filter).toBeFocused();
    expect(await filter.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await capture(page, info, `pr-filter-${locale}-${width}`);
    state.longCounts = false;
    state.scene = 'initial';
    await page.reload();
    await page.locator('#project-section-tab-prs').click();
    await expect(filter.locator('option').first()).not.toContainText('·');
    await assertFits(page);
    expect(state.unexpected).toEqual([]);
  });
}
