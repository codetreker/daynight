import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = '/tests/navigation/ordinary-task-fixture.html';
const evidence = fileURLToPath(new URL('../../../../.tmp/ordinary-task-browser/', import.meta.url));

test('loads, retries, displays five states and follows five real parent edges', async ({ page }) => {
  await page.goto(`${fixture}?fail=1`);
  await expect(page.getByRole('alert')).toContainText('Could not load subtasks');
  await page.getByRole('button', { name: 'Retry' }).click();
  const section = page.getByRole('region', { name: 'Subtasks' });
  for (const status of ['Proposed', 'To do', 'In progress', 'Done', 'Cancelled']) await expect(section.getByText(status, { exact: true })).toBeVisible();
  for (let n = 2; n <= 6; n++) { await section.getByRole('link', { name: `Task ${n}`, exact: true }).click(); await expect(page.getByRole('heading', { name: `Task ${n}`, exact: true })).toBeVisible(); }
  await expect(section.getByText('No subtasks')).toBeVisible();
  for (let n = 5; n >= 1; n--) { await page.getByRole('region', { name: 'Parent Task' }).getByRole('link', { name: `Task ${n}`, exact: true }).click(); await expect(page.getByRole('heading', { name: `Task ${n}`, exact: true })).toBeVisible(); }
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Task 2', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Task 2', exact: true })).toBeVisible(); await expect(page.getByRole('region', { name: 'Parent Task' }).getByRole('link', { name: 'Task 1' })).toBeVisible();
});

test('narrow form uses keyboard, restores focus and creates a fixed-parent Task', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 }); await page.goto(fixture);
  const open = page.getByRole('button', { name: 'New subtask' }); await open.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Parent Task: Task 1');
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Created child');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Created child' })).toBeVisible(); await expect(open).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test('Chinese presentation remains usable with long content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 }); await page.goto(`${fixture}?zh=1`);
  await expect(page.getByRole('region', { name: '子任务' })).toContainText('待处理');
  await page.getByRole('button', { name: '新建子任务' }).click();
  await page.getByRole('textbox', { name: '标题' }).fill('很长的任务标题'.repeat(30));
  await expect(page.getByRole('textbox', { name: '标题' })).toHaveValue('很长的任务标题'.repeat(30));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const width of [1280, 320, 390]) test(`standard child rows keep long titles and UUIDs readable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture}?long=1`);
  const row = page.locator('.task-row').first();
  await expect(row).toContainText('Current user');
  for (const text of ['Windows', 'Automatic execution', 'Blocked', 'Worker record unknown']) await expect(row).toContainText(text);
  await expect(row.locator('.task-row-id')).toHaveText('20000000-0000-4000-8000-000000000002');
  const link = row.getByRole('link');
  await expect(link).toHaveAttribute('href', '/projects/10000000-0000-4000-8000-000000000001/tasks/20000000-0000-4000-8000-000000000002');
  await expect(link).toContainText('Long child title without truncation');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const selector of ['.task-row-title', '.task-row-id']) expect(await row.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await link.focus();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(link).toBeFocused();
  await page.screenshot({ path: `${evidence}/children-${width}.png`, fullPage: true });
});

test('child ID copy preserves navigation and modified child links use native navigation', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { document.documentElement.dataset.copiedTaskId = value; } } });
  });
  await page.goto(fixture);
  const row = page.locator('.task-row').first();
  const initial = page.url();
  await row.getByRole('button', { name: 'Copy task ID' }).click();
  await expect(row.getByRole('status')).toHaveText('Copied');
  expect(page.url()).toBe(initial);
  await expect(page.locator('html')).toHaveAttribute('data-copied-task-id', '20000000-0000-4000-8000-000000000002');
  const popup = context.waitForEvent('page');
  await row.getByRole('link', { name: 'Task 2', exact: true }).click({ modifiers: ['Control'] });
  const opened = await popup;
  await expect(opened).toHaveURL(/\/tasks\/20000000-0000-4000-8000-000000000002$/);
  expect(page.url()).toBe(initial);
  await opened.close();
});
