import type { Locator, Page, TestInfo } from '@playwright/test';
import { parseApiJson, stringifyApiJson } from '../../src/api/json';
import { parseTaskSteps } from '../../src/api/task-steps';
import type { AuthenticatedAPI } from './authentication';
import { expect } from './fixtures';

const root = (page: Page): Locator => page.locator('.task-detail-page, .task-detail-dialog');
const form = (page: Page): Locator => root(page).locator('.step-add-form');
const row = (page: Page, id: string): Locator => root(page).locator(`.step-row[data-step-id="${id}"]`);

type Write = { id: string; requestId: string; status: number };

// Runs as part of the add scenario against the same production service and collection.
export const exerciseRelativeInsert = async (page: Page, api: AuthenticatedAPI, projectId: string, taskId: string, path: string, writes: Write[], info: TestInfo): Promise<void> => {
  const read = async () => {
    const response = await api.get(path); expect(response.status()).toBe(200);
    return parseTaskSteps(parseApiJson(await response.text()), projectId, taskId);
  };
  const pageNumber = () => root(page).getByRole('spinbutton', { name: /页码|Page/ });
  const goPage = async (number: number) => { await pageNumber().fill(String(number)); await pageNumber().press('Enter'); };
  const chooseMenu = async (id: string, label: string) => {
    const button = row(page, id).locator('.step-more');
    await expect(button).toHaveAttribute('aria-disabled', 'false');
    await button.focus(); await page.keyboard.press('ArrowDown');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };

  await goPage(1);
  await chooseMenu('00000000', '在前面添加');
  await expect(form(page)).toContainText('Existing 0');
  await expect(form(page)).toContainText('00000000');
  await form(page).getByRole('textbox', { name: '标题', exact: true }).fill('跨页之前');
  await form(page).getByRole('button', { name: '选择目标', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择目标步骤', exact: true });
  await expect(picker.getByRole('radio')).toHaveCount(100);
  const pickerPage = picker.getByRole('spinbutton', { name: '目标结果页码' });
  await pickerPage.fill('2'); await pickerPage.press('Enter');
  await picker.getByRole('radio', { name: /00000063/ }).click();
  await picker.getByRole('searchbox', { name: '搜索名称或 ID' }).fill('Existing 0');
  await expect(picker.locator('.step-target-selected')).toContainText('00000063');
  await picker.getByRole('button', { name: '选择', exact: true }).click();
  await expect(form(page)).toContainText('Existing 99');
  for (const locale of ['zh-CN', 'en']) {
    await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const image = info.outputPath(`step-insert-${locale}-${width}.png`);
      await page.screenshot({ path: image, animations: 'disabled' });
      await info.attach('scenario-screenshot', { path: image, contentType: 'image/png' });
    }
  }
  await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await page.setViewportSize({ width: 1440, height: 800 });
  await form(page).getByRole('button', { name: '保存', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
  const before = writes[5]!; expect(before.status).toBe(201);
  let current = await read();
  expect(current.steps.findIndex(step => step.id === before.id) + 1).toBe(current.steps.findIndex(step => step.id === '00000063'));
  await expect(pageNumber()).toHaveValue('2');
  await expect(row(page, before.id).locator('.step-disclosure')).toBeFocused();

  await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
  await page.setViewportSize({ width: 320, height: 640 });
  await chooseMenu(before.id, 'Add after');
  await expect(form(page)).toContainText('跨页之前');
  await expect(form(page)).toContainText(before.id);
  await form(page).getByRole('textbox', { name: 'Title', exact: true }).fill('After selected step');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const screenshot = info.outputPath('step-insert-en-320.png');
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path: screenshot, contentType: 'image/png' });
  await form(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
  const after = writes[6]!; expect(after.status).toBe(201);
  current = await read();
  expect(current.steps.findIndex(step => step.id === after.id)).toBe(current.steps.findIndex(step => step.id === before.id) + 1);
  await expect(row(page, after.id).locator('.step-disclosure')).toBeFocused();

  await chooseMenu('00000063', 'Add before');
  await form(page).getByRole('textbox', { name: 'Title', exact: true }).fill('Keep this draft');
  current = await read();
  const removed = await api.delete(`${path}/00000063`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: current.version }) });
  expect(removed.status()).toBe(200);
  await root(page).getByRole('button', { name: 'Refresh steps', exact: true }).click();
  await expect(form(page).getByRole('alert')).toContainText(/target step.*no longer available/i);
  await expect(form(page).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Keep this draft');
  await expect(form(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const removedResource = parseTaskSteps(parseApiJson(await removed.text()), projectId, taskId);
  const recreated = await api.post(path, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: removedResource.version, id: '00000063', title: 'Recreated anchor' }) });
  expect(recreated.status()).toBe(201);
  await root(page).getByRole('button', { name: 'Refresh steps', exact: true }).click();
  await expect(row(page, '00000063')).toContainText('Recreated anchor');
  await expect(form(page).getByRole('alert')).toContainText(/target step.*no longer available/i);
  await expect(form(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await form(page).getByRole('button', { name: 'Choose target', exact: true }).click();
  const englishPicker = page.getByRole('dialog', { name: 'Select target', exact: true });
  await englishPicker.getByRole('searchbox', { name: 'Search name or ID' }).fill('00000063');
  await englishPicker.getByRole('radio', { name: /00000063/ }).click();
  await englishPicker.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(form(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await form(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
  const recovered = writes[7]!; expect(recovered.status).toBe(201);
  current = await read();
  expect(current.steps.findIndex(step => step.id === recovered.id) + 1).toBe(current.steps.findIndex(step => step.id === '00000063'));
  await expect(row(page, recovered.id).locator('.step-disclosure')).toBeFocused();
  await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await page.setViewportSize({ width: 1440, height: 800 });
};
