import type { Page } from '@playwright/test';

export const selectTaskList = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: /^(任务列表|Task list)$/, exact: true }).click();
};

export const selectOverview = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: /^(概览|Overview)$/, exact: true }).click();
};
