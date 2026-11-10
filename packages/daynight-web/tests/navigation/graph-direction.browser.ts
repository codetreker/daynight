import { expect, test, type Page } from '@playwright/test';

const project = '00000000-0000-4000-8000-000000000101', goal = '00000000-0000-4000-8000-000000000001';
const key = `daynight:graph-direction:${JSON.stringify([project, goal])}`;
const open = async (page: Page, name: string) => { await page.getByRole('button', { name, exact: true }).click(); await expect(page.locator('.task-chain-dialog')).toBeVisible(); };
const close = async (page: Page) => { await page.locator('.task-chain-close').click(); await expect(page.locator('.task-chain-dialog')).toHaveCount(0); };
const horizontal = (page: Page) => page.getByRole('radio', { name: 'Horizontal', exact: true });
const vertical = (page: Page) => page.getByRole('radio', { name: 'Vertical', exact: true });

test('direction is scoped to project and Goal across closing and reload', async ({ page }) => {
  await page.goto('/tests/navigation/graph-direction-browser.html'); await open(page, 'Open Goal A');
  await expect(horizontal(page)).toHaveAttribute('aria-checked', 'true'); await vertical(page).click();
  expect(await page.evaluate(name => localStorage.getItem(name), key)).toBe('"vertical"');
  await close(page); await open(page, 'Open Goal B'); await expect(horizontal(page)).toHaveAttribute('aria-checked', 'true');
  await close(page); await open(page, 'Open Goal A'); await expect(vertical(page)).toHaveAttribute('aria-checked', 'true');
  await page.reload(); await open(page, 'Open Goal A'); await expect(vertical(page)).toHaveAttribute('aria-checked', 'true');
  await close(page); await open(page, 'Open other project'); await expect(horizontal(page)).toHaveAttribute('aria-checked', 'true');
  await close(page); await open(page, 'Open Goal A'); await expect(vertical(page)).toHaveAttribute('aria-checked', 'true');
});

test('invalid, unreadable and unwritable saved direction remain visible and recoverable', async ({ page }) => {
  await page.goto('/tests/navigation/graph-direction-browser.html'); await page.evaluate(name => localStorage.setItem(name, '"diagonal"'), key);
  await open(page, 'Open Goal A'); await expect(horizontal(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.graph-preference-notice')).toHaveText('The saved graph direction is invalid. Horizontal is used by default.');
  await vertical(page).click(); await close(page);
  await page.evaluate(name => { const original = Storage.prototype.getItem; Storage.prototype.getItem = function (candidate) { if (candidate === name) throw new Error('fixture read failure'); return original.call(this, candidate); }; }, key);
  await open(page, 'Open Goal A'); await expect(horizontal(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.graph-preference-notice')).toHaveText('The saved graph direction could not be read. You can still change it.');
  await vertical(page).click(); await expect(vertical(page)).toHaveAttribute('aria-checked', 'true');
  await page.reload(); await open(page, 'Open Goal A'); await expect(vertical(page)).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(name => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (candidate, value) { if (candidate === name) throw new Error('fixture write failure'); return original.call(this, candidate, value); }; }, key);
  await horizontal(page).click(); await expect(horizontal(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.graph-preference-notice')).toHaveText('The graph direction could not be saved. It may not return after a reload.');
  await page.reload(); await open(page, 'Open Goal A'); await expect(vertical(page)).toHaveAttribute('aria-checked', 'true');
});
