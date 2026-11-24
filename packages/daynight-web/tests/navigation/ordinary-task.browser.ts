import { expect, test } from '@playwright/test';
const fixture = '/tests/navigation/ordinary-task-fixture.html';

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
