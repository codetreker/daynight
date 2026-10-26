import { expect, type Page } from '@playwright/test';

export const expectOpenChain = async (page: Page, id: string): Promise<void> => {
  await expect(page.locator(`#task-root-${id}`)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(page.locator(`#task-root-${id}`)).toHaveAttribute('aria-controls', `task-graph-${id}`);
  await expect(page.locator(`#task-graph-${id}.task-chain-dialog`)).toBeVisible();
  await expect(page.locator('.task-chain-dialog')).toHaveAttribute('aria-modal', 'true');
};

export const expectClosedChain = async (page: Page, id: string): Promise<void> => {
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
  await expect(page.locator(`#task-root-${id}`)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(page.locator(`#task-root-${id}`)).not.toHaveAttribute('aria-controls');
};

export const closeChain = async (page: Page): Promise<void> => {
  const dialog = page.locator('.task-chain-dialog');
  if (await dialog.count() === 0) return;
  await dialog.locator('.task-chain-close').click();
  await expect(dialog).toHaveCount(0);
};

export const openChain = async (page: Page, id: string): Promise<void> => {
  if (await page.locator(`#task-graph-${id}.task-chain-dialog`).count() === 0) {
    await closeChain(page);
    await page.locator(`#task-root-${id}`).click();
  }
  await expectOpenChain(page, id);
};
