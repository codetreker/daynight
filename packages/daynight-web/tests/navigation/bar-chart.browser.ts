import { expect, test } from '@playwright/test';
const fixture = '/tests/navigation/bar-chart-fixture.html';

test('keyboard, stable selection, pointer and precise scale', async ({ page }) => {
  await page.goto(fixture);
  const chart = page.getByRole('listbox', { name: 'Categories' });
  await page.getByRole('button', { name: 'Zero' }).focus();
  await page.keyboard.press('Tab');
  await expect(chart).toBeFocused();
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 0.*0 items/);
  await page.keyboard.press('End');
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 29.*290000000000000000 items/);
  await page.keyboard.press('ArrowLeft');
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 28/);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 1/);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'After' })).toBeFocused();
  await chart.focus();
  await page.keyboard.press('End');
  const maxBefore = await page.locator('.bar-chart__scale').first().innerText();
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByRole('button', { name: 'Filter' })).toBeFocused();
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 29.*145000000000000000 items/);
  expect(await page.locator('.bar-chart__scale').first().innerText()).toBe(maxBefore);
  await expect(page.locator('.bar-chart__point').nth(29)).toHaveCSS('--bar-chart-height', '50%');
  await page.locator('.bar-chart__point').nth(5).hover();
  await expect(page.locator('.bar-chart__reading').first()).toContainText('Category 5');
  await page.locator('.bar-chart__point').nth(5).click();
  await expect(chart).toBeFocused();
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 5/);
  await page.getByRole('button', { name: 'Shorten' }).click();
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 5/);
  for (const button of ['Shorten', 'Seven']) {
    await page.getByRole('button', { name: button }).click();
    const labels = await page.locator('.bar-chart__labels').first().locator('span').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
    for (let i = 1; i < labels.length; i++) expect(labels[i - 1]!.right).toBeLessThanOrEqual(labels[i]!.left);
  }
  await page.getByRole('button', { name: 'Zero' }).click();
  await expect(chart.getByRole('option', { selected: true })).toHaveAccessibleName(/Category 5.*0 items/);
  await expect(page.getByRole('listbox', { name: 'All zero' }).getByRole('option', { selected: true })).toHaveAccessibleName('One: 0');
});

test('320px and desktop keep labels contained and touch reads a point', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(fixture);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const labels = await page.locator('.bar-chart__labels').first().locator('span').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
    for (let i = 1; i < labels.length; i++) expect(labels[i - 1]!.right).toBeLessThanOrEqual(labels[i]!.left);
    const geometry = await page.locator('.bar-chart').first().evaluate(element => ({
      zero: element.querySelector('.bar-chart__scale span:last-child')!.getBoundingClientRect().bottom,
      baseline: element.querySelector('.bar-chart__plot')!.getBoundingClientRect().bottom,
    }));
    expect(Math.abs(geometry.zero - geometry.baseline)).toBeLessThanOrEqual(2);
  }
  await page.setViewportSize({ width: 320, height: 700 });
  const chart = page.getByRole('listbox', { name: 'Categories' });
  await chart.focus();
  await expect(chart).toHaveCSS('outline-offset', '-2px');
  await page.keyboard.press('End');
  expect(await page.locator('.bar-chart__scroll').first().evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const scroll = page.locator('.bar-chart__scroll').first();
  await scroll.evaluate(element => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2; });
  const visibleLabels = await scroll.locator('.bar-chart__labels span').evaluateAll(nodes => nodes.filter(node => {
    const parent = node.closest('.bar-chart__scroll')!.getBoundingClientRect(), rect = node.getBoundingClientRect();
    return rect.left >= parent.left && rect.right <= parent.right;
  }).length);
  expect(visibleLabels).toBeGreaterThan(0);
  await scroll.evaluate(element => { element.scrollLeft = 0; });
  await page.evaluate(() => window.refreshChart());
  expect(await scroll.evaluate(element => element.scrollLeft)).toBe(0);
  await page.locator('.bar-chart__point').first().hover();
  expect(await scroll.evaluate(element => element.scrollLeft)).toBe(0);
  await page.locator('.bar-chart__point').nth(12).tap();
  await expect(page.getByRole('listbox', { name: 'Categories' }).getByRole('option', { selected: true })).toHaveAccessibleName(/Category 12.*120000000000000000 items/);
  await expect(page.locator('.bar-chart__reading').first()).toContainText('Category 12');
  await context.close();
});
