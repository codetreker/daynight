import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installPrList, projectId, records, type Scene } from './pr-list-fixture';
import { expectChartLabelsFit } from './bar-chart-geometry';

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

for (const width of [1280, 320]) test(`PR typography and responsive search retain input state at ${width}px`, async ({ page }) => {
  const state = await installPrList(page);
  await page.setViewportSize({ width, height: 900 });
  await open(page);
  const row = page.locator('.pr-row').first(), search = page.locator('#pr-search');
  await expect(row.locator('.pr-row-title')).toHaveCSS('font-size', '14px');
  await expect(row.locator('.pr-row-number')).toHaveCSS('font-size', '12px');
  await expect(page.locator('.pr-results-count')).toHaveCSS('font-size', '12px');
  await expect(search).toHaveAttribute('data-touch-text', 'responsive');
  await expect(search).toHaveCSS('font-size', width === 320 ? '16px' : '14px');
  if (width === 320) expect(await search.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await search.fill('Pull request'); await search.focus();
  await search.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 5));
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await expect(search).toBeFocused(); await expect(search).toHaveValue('Pull request');
  expect(await search.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 5]);
  await expect(search).toHaveCSS('font-size', width === 320 ? '32px' : '28px');
  await expect(row.locator('.pr-row-title')).toHaveCSS('font-size', '28px');
  await expect(row.locator('.pr-row-number')).toHaveCSS('font-size', '24px');
  await page.locator('.pr-author-trigger').click();
  const author = page.locator('.pr-author-menu input');
  await expect(author).toHaveAttribute('data-touch-text', 'responsive');
  await expect(author).toHaveCSS('font-size', width === 320 ? '32px' : '28px');
  if (width === 320) expect(await author.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(42);
  await author.fill('author'); await expect(author).toBeFocused();
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await expect(author).toHaveCSS('font-size', width === 320 ? '16px' : '14px');
  await expect(author).toBeFocused(); await expect(author).toHaveValue('author');
  await page.locator('.pr-author-menu').getByRole('option', { name: /^author$/ }).click();
  await expect(page.locator('.pr-author-trigger')).toBeFocused();
  expect(state.unexpected).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 320]) {
  test(`status icons center within short and multiline cards at ${width}px in ${locale}`, async ({ page }) => {
    const state = await installPrList(page, locale);
    state.longContent = true;
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    for (const [filter, first, expected] of [['active', '1248', ['open', 'draft']], ['merged', '1236', ['merged']], ['closed', '1208', ['closed']]] as const) {
      await page.locator('#pr-filter').selectOption(filter);
      await expect(page.locator('.pr-row')).toHaveCount(6);
      await expect(page.locator('.pr-row').first()).toHaveAttribute('id', `pr-row-${first}`);
      for (const tone of expected) {
        const rows = page.locator('.pr-row').filter({ has: page.locator(`.pr-status-icon.${tone}`) });
        expect(await rows.count()).toBeGreaterThanOrEqual(2);
        const heights: number[] = [];
        for (const row of await rows.all()) {
          const geometry = await row.evaluate(element => {
            const row = element.getBoundingClientRect(), icon = element.querySelector('.pr-status-icon')!.getBoundingClientRect();
            const main = element.querySelector('.pr-row-main')!.getBoundingClientRect();
            return { difference: Math.abs(row.top + row.height / 2 - icon.top - icon.height / 2), gap: main.left - icon.right, height: row.height };
          });
          expect(geometry.difference).toBeLessThanOrEqual(1);
          expect(geometry.gap).toBeGreaterThanOrEqual(0);
          heights.push(geometry.height);
        }
        expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
      }
      await assertFits(page);
    }
    expect(state.unexpected).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 800, 390, 320]) {
  test(`PR cards retain geometry and readable long content at ${width}px in ${locale}`, async ({ page }, info) => {
    const state = await installPrList(page, locale);
    state.longContent = true;
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const list = page.locator('.pr-list'), row = page.locator('.pr-row').first();
    const geometry = await row.evaluate(element => {
      const style = getComputedStyle(element), list = element.closest('.pr-list')!, listStyle = getComputedStyle(list);
      const title = getComputedStyle(element.querySelector('.pr-row-title')!), meta = getComputedStyle(element.querySelector('.pr-row-meta')!);
      const boxes = [...list.querySelectorAll('.pr-row')].map(item => item.getBoundingClientRect());
      const content = [...element.querySelectorAll('.pr-row-title, .pr-row-meta > span, .pr-row-branch')].map(item => {
        const box = item.getBoundingClientRect(), main = element.querySelector('.pr-row-main')!.getBoundingClientRect();
        return box.left >= main.left - 1 && box.right <= main.right + 1 && item.scrollWidth <= item.clientWidth + 1;
      });
      return { listWidth: list.getBoundingClientRect().width, gap: boxes[1]!.top - boxes[0]!.bottom, listBorder: listStyle.borderTopWidth, listOverflow: listStyle.overflow,
        padding: style.padding, rowGap: style.columnGap, border: style.borderTop, radius: style.borderRadius, background: style.backgroundColor,
        title: [title.fontSize, title.fontWeight, title.lineHeight, title.color], meta: [meta.fontSize, meta.lineHeight, meta.marginTop, meta.rowGap, meta.columnGap, meta.color], content };
    });
    const compact = geometry.listWidth <= 650;
    expect(geometry.gap).toBe(7);
    expect([geometry.listBorder, geometry.listOverflow]).toEqual(['0px', 'visible']);
    expect([geometry.padding, geometry.rowGap]).toEqual(compact ? ['9px 11px', '6px'] : ['10px 15px', '12px']);
    expect([geometry.border, geometry.radius, geometry.background]).toEqual(['1px solid rgb(213, 220, 229)', '8px', 'rgb(250, 251, 252)']);
    expect(geometry.title).toEqual(['14px', '650', '21px', 'rgb(23, 33, 50)']);
    expect(geometry.meta).toEqual(['14px', '21px', '2px', '3px', '8px', 'rgb(85, 97, 118)']);
    expect(geometry.content.every(Boolean)).toBe(true);
    const badge = page.locator('.pr-row-badge.draft').first();
    await expect(badge).toHaveCSS('color', 'rgb(85, 97, 118)');
    await expect(badge).toHaveCSS('background-color', 'rgb(240, 241, 245)');
    await assertFits(page);
    await row.hover();
    await expect(row).toHaveCSS('background-color', 'rgb(240, 243, 247)');
    await page.keyboard.press('Tab');
    await row.focus();
    await expect(row).toHaveCSS('outline-color', 'rgb(52, 64, 84)');
    await expect(row).toHaveCSS('outline-width', '3px');
    await capture(page, info, `pr-cards-${locale}-${width}`);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
    expect(state.unexpected).toEqual([]);
  });
}

test('PR card density follows the list container at the 650px boundary', async ({ page }) => {
  await installPrList(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const list = page.locator('.pr-list'), row = page.locator('.pr-row').first();
  for (const [width, padding] of [[651, '10px 15px'], [650, '9px 11px']] as const) {
    await list.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
    await expect(row).toHaveCSS('padding', padding);
    await expect(page.locator('.pr-row-time').first()).toBeVisible();
  }
});

test('PR card opens by Space and touch and restores focus without scrolling', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 600 }, hasTouch: true });
  try {
    const page = await context.newPage(), state = await installPrList(page);
    await open(page);
    const row = page.locator('.pr-row').last();
    await row.scrollIntoViewIfNeeded();
    await row.focus();
    for (const action of ['Space', 'touch'] as const) {
      const position = await page.evaluate(() => scrollY);
      if (action === 'Space') await page.keyboard.press('Space');
      else await row.tap();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(row).toBeFocused();
      expect(await page.evaluate(() => scrollY)).toBe(position);
    }
    expect(state.unexpected).toEqual([]);
  } finally {
    await context.close();
  }
});

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
  await page.keyboard.press(width > 740 ? 'ArrowDown' : 'ArrowRight'); await expect(page.locator('#project-section-tab-statistics')).toBeFocused();
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

for (const width of [1440, 800, 390, 320]) test(`connection label follows language and fits ${width}px`, async ({ page }) => {
  const state = await installPrList(page);
  await page.setViewportSize({ width, height: 900 });
  await open(page);
  const label = page.locator('.pr-connected'), heading = page.locator('.pr-title-line h2'), refresh = page.locator('.pr-heading button');
  for (const [locale, text, title] of [['en', 'Connected', 'Pull requests'], ['zh-CN', '已连接', 'PR 列表'], ['en', 'Connected', 'Pull requests']] as const) {
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await expect(label).toHaveText(text);
    await expect(heading).toHaveText(title);
    await expect(page.locator('.pr-sync-status .pr-connected')).toHaveCount(0);
    const geometry = await label.evaluate(element => {
      const label = element.getBoundingClientRect(), title = element.parentElement!.querySelector('h2')!.getBoundingClientRect();
      const button = element.closest('.pr-heading')!.querySelector('button')!.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { label: { left: label.left, right: label.right, top: label.top, bottom: label.bottom }, title: { left: title.left, right: title.right, top: title.top, bottom: title.bottom }, button: { left: button.left, right: button.right, top: button.top, bottom: button.bottom }, color: style.color, overflow: element.scrollWidth > element.clientWidth };
    });
    expect(geometry.color).toBe('rgb(37, 106, 72)');
    expect(geometry.overflow).toBe(false);
    for (const other of [geometry.title, geometry.button]) {
      expect(geometry.label.right <= other.left || geometry.label.left >= other.right || geometry.label.bottom <= other.top || geometry.label.top >= other.bottom).toBe(true);
    }
    await expect(refresh).toBeVisible();
    await assertFits(page);
  }
  expect(state.unexpected).toEqual([]);
});

test('all 48 summaries are reachable with server cursors, filters and page state survive section history', async ({ page }) => {
  const state = await installPrList(page);
  await open(page);
  const panel = page.locator('#project-section-panel-prs'), filter = panel.locator('#pr-filter'), search = panel.locator('.pr-toolbar input');
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
    const heading = page.locator('.pr-heading');
    await expect(heading.getByRole('heading', { name: locale === 'en' ? 'Pull requests' : 'PR 列表' })).toBeVisible();
    const refresh = heading.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新' });
    await expect(refresh).toBeVisible();
    await expect(heading.locator('p')).toHaveCount(0);
    const titleBox = await heading.locator('.pr-title-line').boundingBox(), refreshBox = await refresh.boundingBox();
    expect(Math.abs(titleBox!.y + titleBox!.height / 2 - refreshBox!.y - refreshBox!.height / 2)).toBeLessThanOrEqual(1);
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
  const filter = panel.locator('#pr-filter'), search = panel.locator('.pr-toolbar input');
  await filter.selectOption('all');
  await search.fill('Pull request');
  await expect(page.locator('.pr-row')).toHaveCount(6);
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.pr-row').first()).toContainText('#1241');
  const language = page.getByRole('combobox', { name: '语言 / Language' });
  await language.selectOption('zh-CN');
  await expect(panel.locator('.pr-connected')).toHaveText('已连接');
  await expect(filter).toHaveValue('all'); await expect(search).toHaveValue('Pull request');
  await expect(page.locator('.pr-row').first()).toContainText('#1241');
  await language.selectOption('en');
  await expect(panel.locator('.pr-connected')).toHaveText('Connected');
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
  await expect(panel.locator('.pr-connected')).toHaveText('Connected');
  state.scene = 'disconnected'; state.revision++;
  await page.clock.fastForward(15_100);
  await expect(panel.locator('.pr-connected')).toHaveCount(0);
  state.scene = 'populated'; state.revision++;
  await page.clock.fastForward(15_100);
  await expect(panel.locator('.pr-connected')).toHaveText('Connected');
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
    const arrow = filter.locator('..').locator('.native-select__arrow');
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
    await expect(page.locator('.pr-heading button')).toHaveAttribute('aria-busy', 'false');
    const box = (await arrow.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(filter).toBeFocused();
    await expect.poll(() => filter.evaluate(element => element.matches(':open'))).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(filter).toHaveValue('merged');
    await page.keyboard.press('Tab');
    await expect(page.locator('.pr-author-trigger')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#pr-search')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.pr-author-trigger')).toBeFocused();
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

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 800, 390, 320]) {
  test(`creator picker, long identity and section return at ${width}px in ${locale}`, async ({ page }, info) => {
    const state = await installPrList(page, locale);
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const trigger = page.locator('.pr-author-trigger'), filter = page.locator('#pr-filter');
    await filter.selectOption('all');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('.pr-author-menu'), search = menu.getByRole('combobox');
    await expect(search).toBeFocused();
    await expect(menu.getByRole('option')).toHaveCount(51);
    await assertFits(page);
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    await search.fill('very-long');
    const long = menu.getByRole('option', { name: /very-long-github-username/ });
    await expect(long).toBeVisible();
    const nameGeometry = await long.locator('.pr-author-name').evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(nameGeometry.scroll).toBeLessThanOrEqual(nameGeometry.client + 1);
    await capture(page, info, `creator-${locale}-${width}`);
    await long.click();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('very-long');
    await expect(page.locator('.pr-row')).toHaveCount(6);
    await expect(page.locator('.pr-row').first()).toContainText('#1206');
    await page.locator('#pr-search').fill('1205');
    await expect(page.locator('.pr-row')).toHaveCount(1);
    await expect(page.locator('.pr-row').first()).toContainText('#1205');
    await page.locator('#project-section-tab-tasks').click();
    await page.locator('#project-section-tab-prs').click();
    await expect(trigger).toContainText('very-long');
    await expect(page.locator('#pr-search')).toHaveValue('1205');
    await expect(page.locator('.pr-row').first()).toContainText('#1205');
    await assertFits(page);
    expect(state.pageReads.some(query => query.includes('authorId=9001'))).toBe(true);
    expect(state.unexpected).toEqual([]);
  });
}

test('creator keyboard, IME, Tab and external click maintain focus and independent search', async ({ page }) => {
  const state = await installPrList(page);
  await open(page);
  const trigger = page.locator('.pr-author-trigger'), prSearch = page.locator('#pr-search');
  await prSearch.fill('1248');
  await expect(page.locator('.pr-row')).toHaveCount(1);
  await trigger.focus();
  await page.keyboard.press('Space');
  const menu = page.locator('.pr-author-menu'), search = menu.getByRole('combobox');
  await expect(search).toBeFocused();
  await expect(menu.getByRole('option')).toHaveCount(51);
  const reads = state.authorReads.length;
  await search.dispatchEvent('compositionstart');
  await search.fill('author');
  await page.waitForTimeout(400);
  expect(state.authorReads).toHaveLength(reads);
  await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  await expect(menu).toBeVisible();
  await search.dispatchEvent('compositionend', { data: 'author' });
  await expect.poll(() => state.authorReads.length).toBeGreaterThan(reads);
  await expect(menu.getByRole('option', { name: 'author', exact: true })).toBeVisible();
  await expect(prSearch).toHaveValue('1248');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('author');
  await expect(trigger).toBeFocused();
  await expect(page.locator('.pr-row')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('');
  await expect(menu.getByRole('button', { name: 'Load more' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await expect(menu.getByRole('button', { name: 'Load more' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Load more' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(prSearch).toBeFocused();
  await expect(menu).toBeVisible();
  await prSearch.click();
  await expect(prSearch).toBeFocused();
  await expect(menu).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});

test('creator popup and search survive mouse and keyboard section navigation', async ({ page }) => {
  const state = await installPrList(page);
  await open(page);
  const trigger = page.locator('.pr-author-trigger'), menu = page.locator('.pr-author-menu');
  await trigger.click();
  const search = menu.getByRole('combobox');
  await search.fill('creator075');
  await expect(menu.getByRole('option', { name: 'creator075' })).toBeVisible();
  await page.locator('#project-section-tab-tasks').click();
  await expect(menu).toBeHidden();
  await page.locator('#project-section-tab-prs').click();
  await expect(menu).toBeVisible();
  await expect(search).toHaveValue('creator075');
  await expect(menu.getByRole('option', { name: 'creator075' })).toBeVisible();
  await search.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#pr-filter')).toBeFocused();
  await expect(menu).toBeVisible();
  await page.locator('#project-section-tab-prs').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#project-section-tab-tasks')).toBeFocused();
  await expect(menu).toBeHidden();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#project-section-tab-prs')).toBeFocused();
  await expect(menu).toBeVisible();
  await expect(search).toHaveValue('creator075');
  expect(state.unexpected).toEqual([]);
});

test('directory conflict retains two pages until the complete replacement preserves the reading anchor', async ({ page }) => {
  const state = await installPrList(page);
  await open(page);
  await page.locator('.pr-author-trigger').click();
  const menu = page.locator('.pr-author-menu');
  await expect(menu.getByRole('option')).toHaveCount(51);
  await menu.getByRole('button', { name: 'Load more' }).click();
  await expect(menu.getByRole('option')).toHaveCount(101);
  const anchor = menu.getByRole('option', { name: 'creator075' });
  await anchor.scrollIntoViewIfNeeded();
  const scroll = menu.locator('.pr-author-scroll');
  const before = await anchor.evaluate(element => element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top);
  state.revision++;
  await menu.getByRole('button', { name: 'Load more' }).click();
  await expect(menu.getByRole('alert')).toBeVisible();
  await expect(menu.getByRole('option')).toHaveCount(101);
  await menu.getByRole('button', { name: 'Retry' }).click();
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(menu.getByRole('option')).toHaveCount(101);
  const after = await anchor.evaluate(element => element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(state.unexpected).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test(`project statistics charts and author selection at ${width}px in ${locale}`, async ({ page }) => {
    const state = await installPrList(page, locale);
    await page.route('**/pull-request-statistics?*', async route => {
      const url = new URL(route.request().url()), authorId = url.searchParams.get('authorId');
      const daily = Array(30).fill('0'); daily[29] = '4';
      const authorDaily = Array(30).fill('0'); authorDaily[29] = '2';
      await route.fulfill({ json: { projectId, repository: { repositoryId: '10', fullName: 'codetreker/daynight' }, endDate: url.searchParams.get('endDate'), revision: '1', projectTotal: '5', availability: 'ready', hasAuthors: true, daily, authorId, author: authorId ? { id: authorId, login: 'author' } : null, authorDaily: authorId ? authorDaily : null }, headers: { 'Daynight-User-ID': '00000000-0000-4000-8000-000000000201' } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}?tab=statistics`);
    const panel = page.locator('#project-section-panel-statistics');
    const taskChart = panel.getByRole('listbox', { name: locale === 'en' ? 'Tasks created daily' : '每日新建任务' });
    const prChart = panel.getByRole('listbox', { name: locale === 'en' ? 'PRs created daily' : '每日新建 PR' });
    await expect(taskChart.getByRole('option')).toHaveCount(30);
    await expect(prChart.getByRole('option')).toHaveCount(30);
    const cards = panel.locator('.statistics-card');
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) {
      const title = card.locator('.statistics-chart-heading h3');
      const control = card.locator('.statistics-chart-heading select, .statistics-chart-heading button');
      await expect(card.locator('.statistics-header h2')).toHaveCSS('font-size', '18px');
      await expect(title).toHaveCSS('font-size', '14px');
      const geometry = await title.evaluate(element => {
        const heading = element.parentElement!, control = heading.querySelector('select, button')!;
        const text = document.createRange(); text.selectNodeContents(element);
        const titleBox = text.getBoundingClientRect(), controlBox = control.getBoundingClientRect(), box = heading.getBoundingClientRect();
        return { titleLeft: titleBox.left, titleRight: titleBox.right, titleTop: titleBox.top, titleBottom: titleBox.bottom,
          controlLeft: controlBox.left, controlRight: controlBox.right, controlTop: controlBox.top,
          controlBottom: controlBox.bottom, left: box.left, right: box.right, scroll: element.scrollWidth, client: element.clientWidth };
      });
      expect(geometry.titleLeft).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(geometry.titleRight).toBeLessThanOrEqual(geometry.right + 1);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      expect(geometry.controlLeft).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(geometry.controlRight).toBeLessThanOrEqual(geometry.right + 1);
      expect(geometry.titleBottom <= geometry.controlTop + 1 || geometry.controlBottom <= geometry.titleTop + 1 || geometry.titleRight <= geometry.controlLeft + 1).toBe(true);
      if (width === 320) expect(geometry.controlTop).toBeGreaterThanOrEqual(geometry.titleBottom - 1);
    }
    for (const chart of [taskChart, prChart]) await expectChartLabelsFit(chart.locator('..'));
    await expect(prChart.getByRole('option').last()).toHaveAttribute('aria-label', /: 4$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const chart of [taskChart, prChart]) {
      await chart.focus(); await page.keyboard.press('End');
      await expect(chart.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
      await expect(chart.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " bar-chart ")][1]').locator('output')).toHaveText((await chart.getByRole('option').last().getAttribute('aria-label'))!);
    }
    const picker = panel.locator('.pr-author-trigger');
    await picker.click();
    await page.locator('[data-author-id="42"]').click();
    await expect(prChart.getByRole('option').last()).toHaveAttribute('aria-label', /: 2$/);
    await expect(panel.locator('.statistics-total strong').last()).toHaveText('5');
    await expect(picker).toBeFocused();
    expect(state.pageReads).toEqual([]);
    await page.reload();
    await expect(page.locator('#project-section-tab-statistics')).toHaveAttribute('aria-selected', 'true');
  });
}

test('statistics charts expose the touched date and count at phone width', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 800 }, hasTouch: true });
  try {
    const page = await context.newPage();
    const state = await installPrList(page);
    await page.route('**/pull-request-statistics?*', async route => {
      const url = new URL(route.request().url()), daily = Array(30).fill('0');
      daily[29] = '4';
      await route.fulfill({ json: { projectId, repository: { repositoryId: '10', fullName: 'codetreker/daynight' }, endDate: url.searchParams.get('endDate'), revision: '1', projectTotal: '5', availability: 'ready', hasAuthors: false, daily, authorId: null, author: null, authorDaily: null }, headers: { 'Daynight-User-ID': '00000000-0000-4000-8000-000000000201' } });
    });
    await page.goto(`/projects/${projectId}?tab=statistics`);
    const panel = page.locator('#project-section-panel-statistics');
    for (const [label, expected] of [['Tasks created daily', /: [0-9]+$/], ['PRs created daily', /: 4$/]] as const) {
      const chart = panel.getByRole('listbox', { name: label });
      await expect(chart.getByRole('option')).toHaveCount(30);
      const last = chart.getByRole('option').last();
      await last.tap();
      await expect(last).toHaveAttribute('aria-selected', 'true');
      const reading = await last.getAttribute('aria-label');
      expect(reading).toMatch(expected);
      await expect(chart.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " bar-chart ")][1]').locator('output')).toHaveText(reading!);
      await chart.evaluate(element => { element.parentElement!.scrollLeft = 0; });
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(chart).toBeFocused();
      await expect.poll(() => chart.evaluate(element => element.parentElement!.scrollLeft)).toBeGreaterThan(0);
      const visible = await last.evaluate(element => {
        const point = element.getBoundingClientRect(), scroll = element.parentElement!.parentElement!.getBoundingClientRect();
        return point.left >= scroll.left - 1 && point.right <= scroll.right + 1;
      });
      expect(visible).toBe(true);
    }
    expect(state.unexpected).toEqual([]);
  } finally {
    await context.close();
  }
});

test('task statistics failure leaves PR statistics readable and retry restores the task chart', async ({ page }) => {
  const state = await installPrList(page);
  state.graphFailure = true;
  await page.goto(`/projects/${projectId}?tab=statistics`);
  const panel = page.locator('#project-section-panel-statistics');
  const taskCard = panel.locator('.statistics-card').first(), prCard = panel.locator('.statistics-card').last();
  await expect(taskCard.getByRole('alert')).toContainText('Unable to load task statistics');
  await expect(taskCard.getByRole('listbox')).toHaveCount(0);
  await expect(prCard.getByRole('listbox', { name: 'PRs created daily' }).getByRole('option')).toHaveCount(30);
  await expect(prCard.locator('.statistics-total strong')).toHaveText('0');
  state.graphFailure = false;
  await taskCard.getByRole('button', { name: 'Retry' }).click();
  await expect(taskCard.getByRole('listbox', { name: 'Tasks created daily' }).getByRole('option')).toHaveCount(30);
  await expect(taskCard.locator('.statistics-total strong')).toHaveText('1');
  await expect(prCard.getByRole('listbox', { name: 'PRs created daily' }).getByRole('option')).toHaveCount(30);
  expect(state.unexpected).toEqual([]);
});

test('PR statistics failure leaves task statistics readable and retry restores the PR chart', async ({ page }) => {
  const state = await installPrList(page);
  let fail = true;
  await page.route('**/pull-request-statistics?*', async route => {
    if (fail) return route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'Fixture read failure', requestId: 'statistics-fixture' } }, headers: { 'Daynight-User-ID': '00000000-0000-4000-8000-000000000201' } });
    const url = new URL(route.request().url());
    return route.fulfill({ json: { projectId, repository: { repositoryId: '10', fullName: 'codetreker/daynight' }, endDate: url.searchParams.get('endDate'), revision: '1', projectTotal: '5', availability: 'ready', hasAuthors: false, daily: Array(30).fill('0'), authorId: null, author: null, authorDaily: null }, headers: { 'Daynight-User-ID': '00000000-0000-4000-8000-000000000201' } });
  });
  await page.goto(`/projects/${projectId}?tab=statistics`);
  const panel = page.locator('#project-section-panel-statistics');
  const taskCard = panel.locator('.statistics-card').first(), prCard = panel.locator('.statistics-card').last();
  await expect(prCard.getByRole('alert')).toContainText('Unable to load PR statistics');
  await expect(prCard.getByRole('listbox')).toHaveCount(0);
  await expect(taskCard.getByRole('listbox', { name: 'Tasks created daily' }).getByRole('option')).toHaveCount(30);
  await expect(taskCard.locator('.statistics-total strong')).toHaveText('1');
  fail = false;
  await prCard.getByRole('button', { name: 'Retry' }).click();
  await expect(prCard.getByRole('listbox', { name: 'PRs created daily' }).getByRole('option')).toHaveCount(30);
  await expect(prCard.locator('.statistics-total strong')).toHaveText('5');
  await expect(taskCard.getByRole('listbox', { name: 'Tasks created daily' }).getByRole('option')).toHaveCount(30);
  expect(state.unexpected).toEqual([]);
});


test('project navigation labels remain distinct at 320px in both languages', async ({ page }) => {
  const state = await installPrList(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/projects/${projectId}?tab=statistics`);
  const tabs = page.locator('.project-section-tab');
  for (const locale of ['en', 'zh-CN']) {
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const labels = await tabs.evaluateAll(elements => elements.map(element => {
      const text = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      if (!text) throw new Error('Missing tab label');
      const range = document.createRange(); range.selectNodeContents(text);
      const box = range.getBoundingClientRect(), tab = element.getBoundingClientRect();
      return { label: text.textContent, left: box.left, right: box.right, tabLeft: tab.left, tabRight: tab.right };
    }));
    expect(labels).toHaveLength(5);
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index]!;
      expect(label.left, `${locale}: ${label.label} starts inside its tab`).toBeGreaterThanOrEqual(label.tabLeft - 1);
      expect(label.right, `${locale}: ${label.label} ends inside its tab`).toBeLessThanOrEqual(label.tabRight + 1);
      if (index > 0) expect(label.left, `${locale}: adjacent labels do not overlap`).toBeGreaterThanOrEqual(labels[index - 1]!.right);
    }
    await page.locator('.project-section-tab[aria-selected="true"]').focus();
    for (const [key, section] of [['End', 'tags'], ['Home', 'overview']] as const) {
      await page.keyboard.press(key);
      const tab = page.locator(`#project-section-tab-${section}`);
      await expect(tab).toBeFocused();
      await expect.poll(() => tab.evaluate(element => {
        const selected = element.getBoundingClientRect(), container = element.parentElement!.getBoundingClientRect();
        return selected.left >= container.left - 1 && selected.right <= container.right + 1;
      })).toBe(true);
    }
  }
  expect(state.unexpected).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`statistics headings and long authors fit 320px in ${locale}`, async ({ page }) => {
  const state = await installPrList(page, locale);
  const longLogin = 'very-long-github-username-for-testing-visibility-and-wrapping';
  await page.route('**/pull-request-statistics?*', async route => {
    const url = new URL(route.request().url()), authorId = url.searchParams.get('authorId');
    const daily = Array(30).fill('0'); daily[29] = '4';
    const authorDaily = Array(30).fill('0'); authorDaily[29] = '2';
    await route.fulfill({ json: { projectId, repository: { repositoryId: '10', fullName: 'codetreker/daynight' }, endDate: url.searchParams.get('endDate'), revision: '1', projectTotal: '5', availability: 'ready', hasAuthors: true, daily, authorId, author: authorId ? { id: authorId, login: longLogin } : null, authorDaily: authorId ? authorDaily : null }, headers: { 'Daynight-User-ID': '00000000-0000-4000-8000-000000000201' } });
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/projects/${projectId}?tab=statistics`);
  const panel = page.locator('#project-section-panel-statistics');
  const headings = panel.locator('.statistics-chart-heading');
  await expect(headings).toHaveCount(2);
  for (const heading of await headings.all()) {
    const title = heading.locator('h3'), control = heading.locator('select, button');
    await expect(title).toBeVisible(); await expect(control).toBeVisible();
    const geometry = await heading.evaluate(element => {
      const title = element.querySelector('h3')!, control = element.querySelector('select, button')!;
      const box = element.getBoundingClientRect(), titleBox = title.getBoundingClientRect(), controlBox = control.getBoundingClientRect();
      const style = getComputedStyle(title);
      return { title: { left: titleBox.left, right: titleBox.right, bottom: titleBox.bottom, height: titleBox.height, scroll: title.scrollWidth, client: title.clientWidth },
        control: { left: controlBox.left, right: controlBox.right, top: controlBox.top, width: controlBox.width }, box: { left: box.left, right: box.right }, lineHeight: parseFloat(style.lineHeight) };
    });
    expect(geometry.title.left).toBeGreaterThanOrEqual(geometry.box.left - 1);
    expect(geometry.title.right).toBeLessThanOrEqual(geometry.box.right + 1);
    expect(geometry.title.scroll).toBeLessThanOrEqual(geometry.title.client + 1);
    expect(geometry.title.height).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
    expect(geometry.control.top).toBeGreaterThanOrEqual(geometry.title.bottom - 1);
    expect(geometry.control.left).toBeGreaterThanOrEqual(geometry.box.left - 1);
    expect(geometry.control.right).toBeLessThanOrEqual(geometry.box.right + 1);
    expect(geometry.control.width).toBeGreaterThanOrEqual(44);
  }
  for (const card of await panel.locator('.statistics-card').all()) {
    const labels = card.locator('.bar-chart__labels span');
    await expect(labels).toHaveCount(5);
    for (const label of await labels.all()) expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const scroller = card.locator('.bar-chart__scroll');
    for (const position of [0, 0.5, 1]) {
      await scroller.evaluate((element, fraction) => { element.scrollLeft = (element.scrollWidth - element.clientWidth) * fraction; }, position);
      await expect.poll(() => scroller.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const shown = [...element.querySelectorAll('.bar-chart__labels span')].filter(label => getComputedStyle(label).visibility === 'visible');
        return shown.length > 0 && shown.every(label => {
          const box = label.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      })).toBe(true);
    }
  }
  const picker = panel.locator('.pr-author-trigger');
  await picker.click();
  const menu = page.locator('.pr-author-menu');
  await menu.getByRole('combobox').fill('very-long');
  const option = menu.getByRole('option', { name: new RegExp(longLogin) });
  await expect(option).toBeVisible();
  const menuBox = (await menu.boundingBox())!, optionBox = (await option.boundingBox())!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0); expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(320);
  expect(optionBox.x).toBeGreaterThanOrEqual(menuBox.x - 1); expect(optionBox.x + optionBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width + 1);
  expect(await option.locator('.pr-author-name').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await option.click();
  await expect(picker).toHaveAttribute('title', new RegExp(longLogin));
  await expect(picker).toHaveAttribute('aria-label', new RegExp(longLogin));
  await expect(panel.getByRole('listbox', { name: locale === 'en' ? 'PRs created daily' : '每日新建 PR' }).getByRole('option').last()).toHaveAttribute('aria-label', /: 2$/);
  const pickerBox = (await picker.boundingBox())!, parentBox = (await picker.locator('..').boundingBox())!;
  expect(pickerBox.x).toBeGreaterThanOrEqual(parentBox.x - 1); expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(parentBox.x + parentBox.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.unexpected).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 320]) {
  test(`new matching PRs join the first page without disturbing the creator menu at ${width}px in ${locale}`, async ({ page }) => {
    const state = await installPrList(page, locale);
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    await open(page);
    const trigger = page.locator('.pr-author-trigger'), menu = page.locator('.pr-author-menu');
    await trigger.click();
    await menu.getByRole('option', { name: /^author$/ }).click();
    const search = page.locator('#pr-search');
    await search.fill('Pull request');
    await expect(page.locator('.pr-row').first()).toContainText('#1247');
    await trigger.click();
    const menuSearch = menu.getByRole('combobox');
    await expect(menuSearch).toBeFocused();
    await menu.evaluate(element => element.setAttribute('data-menu-witness', 'retained'));
    const retainedRow = page.locator('#pr-row-1247');
    await retainedRow.evaluate(element => element.setAttribute('data-row-witness', 'retained'));
    const position = await page.evaluate(() => scrollY);
    let release!: () => void;
    state.holdPages = new Promise<void>(resolve => { release = resolve; });
    state.added = [
      { ...records[0]!, number: '1250', id: '9250', title: 'Pull request other author', author: { id: '9001', login: 'other' } },
      { ...records[0]!, number: '1249', id: '9249', title: 'Pull request newly synchronized' },
    ];
    state.revision++;
    const reads = state.pageReads.length;
    try {
      await page.clock.fastForward(15_100);
      await expect.poll(() => state.pageReads.length).toBeGreaterThan(reads);
      expect(new URLSearchParams(state.pageReads.at(-1)).has('cursor')).toBe(false);
      await expect(retainedRow).toHaveAttribute('data-row-witness', 'retained');
      await expect(menu).toHaveAttribute('data-menu-witness', 'retained');
      await expect(menuSearch).toBeFocused();
      await expect(page.locator('.pr-heading button')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('.pr-heading button')).toBeEnabled();
      await expect(page.locator('.pr-row')).toHaveCount(6);
    } finally { state.holdPages = null; release(); }
    await expect(page.locator('.pr-row').first()).toContainText('#1249');
    await expect(page.locator('.pr-row')).toHaveCount(6);
    await expect(page.locator('.pr-results-count')).toContainText('11');
    await expect(page.locator('#pr-row-1250')).toHaveCount(0);
    await expect(retainedRow).toHaveAttribute('data-row-witness', 'retained');
    await expect(menu).toHaveAttribute('data-menu-witness', 'retained');
    await expect(menuSearch).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(position);
    await expect(page.locator('.pull-request-workspace')).not.toContainText(/New pull requests are available|有新的 PR，刷新后可纳入当前列表/);
    await assertFits(page);
    expect(state.unexpected).toEqual([]);
  });

  test(`an empty first page accepts its first matching PR at ${width}px in ${locale}`, async ({ page }) => {
    const state = await installPrList(page, locale);
    state.removed = records.map(item => item.number);
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-prs').click();
    await expect(page.locator('.pr-empty-state')).toBeVisible();
    const search = page.locator('#pr-search');
    await search.fill('newly synchronized');
    await expect(page.locator('.pr-empty-state')).toContainText(locale === 'en' ? 'No matching pull requests' : '没有找到匹配的 PR');
    await search.focus();
    state.added = [
      { ...records[0]!, number: '1250', id: '9250', title: 'Does not match' },
      { ...records[0]!, number: '1249', id: '9249', title: 'newly synchronized' },
    ];
    state.revision++;
    await page.clock.fastForward(15_100);
    await expect(page.locator('.pr-row')).toHaveCount(1);
    await expect(page.locator('.pr-row').first()).toContainText('#1249');
    await expect(page.locator('.pr-results-count')).toContainText('1');
    await expect(search).toBeFocused();
    await expect(page.locator('.pull-request-workspace')).not.toContainText(/New pull requests are available|有新的 PR，刷新后可纳入当前列表/);
    await expect(page.locator('.pr-pagination button').first()).toBeDisabled();
    await expect(page.locator('.pr-pagination button').last()).toBeDisabled();
    await assertFits(page);
    expect(state.unexpected).toEqual([]);
  });
}

test('anchored pages stay put and a return to the first boundary resumes live first-page updates', async ({ page }) => {
  const state = await installPrList(page);
  await page.clock.install();
  await open(page);
  const panel = page.locator('#project-section-panel-prs');
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.pr-row').first()).toContainText('#1242');
  state.added = [{ ...records[0]!, number: '1249', id: '9249', title: 'Newly synchronized' }];
  state.revision++;
  await page.clock.fastForward(15_100);
  await expect(panel.locator('.pr-results-count')).toContainText('13');
  await expect(page.locator('.pr-row').first()).toContainText('#1242');
  await panel.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.locator('.pr-row').first()).toContainText('#1248');
  const reads = state.pageReads.length;
  await page.clock.fastForward(15_100);
  await expect(page.locator('.pr-row').first()).toContainText('#1249');
  expect(new URLSearchParams(state.pageReads[reads]).has('cursor')).toBe(false);
  expect(state.unexpected).toEqual([]);
});

test('background failure remains retryable during the next check and leaves an open detail intact', async ({ page }) => {
  const state = await installPrList(page);
  await page.clock.install();
  await open(page);
  await page.locator('#pr-row-1247').click();
  const dialog = page.getByRole('dialog'), raw = dialog.getByRole('checkbox', { name: 'Raw Markdown' });
  await raw.check();
  await dialog.evaluate(element => element.setAttribute('data-detail-witness', 'retained'));
  const body = dialog.locator('.dialog-body');
  const position = await body.evaluate(element => { element.scrollTop = Math.floor(element.scrollHeight / 2); return element.scrollTop; });
  state.pageError = true;
  await page.clock.fastForward(15_100);
  const alert = page.locator('#project-section-panel-prs').getByRole('alert');
  await expect(alert).toContainText('Could not read pull requests');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  let release!: () => void;
  state.holdPages = new Promise<void>(resolve => { release = resolve; });
  state.pageError = false;
  state.added = [{ ...records[0]!, number: '1249', id: '9249', title: 'Newly synchronized' }];
  state.revision++;
  const reads = state.pageReads.length;
  try {
    await page.clock.fastForward(15_100);
    await expect.poll(() => state.pageReads.length).toBeGreaterThan(reads);
    await expect(alert).toBeVisible();
    await expect(dialog).toHaveAttribute('data-detail-witness', 'retained');
    await expect(raw).toBeChecked();
    await expect(raw).toBeFocused();
    await expect(page.locator('.pr-heading button')).toHaveAttribute('aria-busy', 'false');
  } finally { state.holdPages = null; release(); }
  await expect(alert).toHaveCount(0);
  await expect(page.locator('.pr-row').first()).toContainText('#1249');
  await expect(dialog).toHaveAttribute('data-detail-witness', 'retained');
  await expect(raw).toBeChecked();
  await expect(raw).toBeFocused();
  expect(await body.evaluate(element => element.scrollTop)).toBe(position);
  expect(state.unexpected).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`repository selection isolates same-number details and statistics at 320px in ${locale}`, async ({ page }) => {
  const state = await installPrList(page, locale);
  const reads: string[] = [];
  const user = '00000000-0000-4000-8000-000000000201';
  const repository = (id: string) => ({ repositoryId: id, fullName: id === '10' ? 'owner/current' : 'owner/history' });
  await page.route('**/pull-request-repositories*', route => route.fulfill({ json: { currentRepositoryId: '10', items: [repository('10'), repository('11')], nextCursor: null }, headers: { 'Daynight-User-ID': user } }));
  await page.route('**/pull-requests?*', route => {
    const id = new URL(route.request().url()).searchParams.get('repositoryId')!; reads.push(`list:${id}`);
    const item = { ...records[0]!, number: '123', title: id === '10' ? 'Current 123' : 'Historical 123', url: `https://github.com/${repository(id).fullName}/pull/123`, base: { repositoryId: id, repositoryFullName: repository(id).fullName, ref: 'main' } };
    return route.fulfill({ json: { projectId, repository: repository(id), revision: '1', items: [item], total: '1', counts: { active: '1', merged: '0', closed: '0', all: '1' }, previousCursor: null, nextCursor: null }, headers: { 'Daynight-User-ID': user } });
  });
  await page.route('**/pull-requests/123?*', route => {
    const id = new URL(route.request().url()).searchParams.get('repositoryId')!; reads.push(`detail:${id}`);
    return route.fulfill({ json: { ...records[0]!, number: '123', title: id === '10' ? 'Current 123' : 'Historical 123', url: `https://github.com/${repository(id).fullName}/pull/123`, base: { repositoryId: id, repositoryFullName: repository(id).fullName, ref: 'main' }, description: 'Repository-specific description' }, headers: { 'Daynight-User-ID': user } });
  });
  await page.route('**/pull-request-statistics?*', route => {
    const id = new URL(route.request().url()).searchParams.get('repositoryId')!; reads.push(`statistics:${id}`);
    return route.fulfill({ json: { projectId, repository: repository(id), endDate: new URL(route.request().url()).searchParams.get('endDate'), revision: '1', projectTotal: id === '10' ? '1' : '2', availability: 'ready', hasAuthors: false, daily: Array(30).fill('0'), authorId: null, author: null, authorDaily: null }, headers: { 'Daynight-User-ID': user } });
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/projects/${projectId}?tab=prs`);
  const source = page.locator('#pr-source');
  await expect(source).toHaveValue('10');
  await page.locator('#pr-row-123').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Current 123');
  await expect(page.getByRole('dialog').getByRole('link', { name: /GitHub/i })).toHaveAttribute('href', 'https://github.com/owner/current/pull/123');
  await page.keyboard.press('Escape');
  await source.focus(); await source.selectOption('11');
  await expect(page.locator('#pr-row-123')).toContainText('Historical 123');
  await expect(page.locator('.pr-connected')).toHaveCount(0);
  await page.locator('#pr-row-123').click();
  await expect(page.getByRole('dialog')).toContainText('Historical 123');
  await expect(page.getByRole('dialog').getByRole('link', { name: /GitHub/i })).toHaveAttribute('href', 'https://github.com/owner/history/pull/123');
  await page.keyboard.press('Escape');
  await page.locator('#project-section-tab-statistics').click();
  await expect(page.locator('#project-section-panel-statistics .statistics-total strong').last()).toHaveText('2');
  expect(reads).toEqual(expect.arrayContaining(['list:10', 'list:11', 'detail:10', 'detail:11', 'statistics:11']));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.unexpected).toEqual([]);
});
