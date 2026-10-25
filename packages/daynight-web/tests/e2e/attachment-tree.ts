import { expect, type Locator } from '@playwright/test';

const exact = (value: string): RegExp => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

export const attachmentFileButton = async (region: Locator, path: string): Promise<Locator> => {
  let branch = region.getByRole('navigation', { name: /^(附件文件|Attachment files)$/ }).locator(':scope > ul');
  const parts = path.split('/');
  for (const name of parts.slice(0, -1)) {
    const summary = branch.locator(':scope > li > details > summary').filter({ hasText: exact(`▱ ${name}`) });
    await expect(summary).toHaveCount(1);
    const directory = summary.locator('..');
    if (await directory.getAttribute('open') === null) await summary.click();
    branch = directory.locator(':scope > ul');
  }
  const name = branch.locator(':scope > li > .attachment-file-row > .attachment-file > .attachment-file-name').filter({ hasText: exact(parts.at(-1)!) });
  await expect(name).toHaveCount(1);
  return name.locator('..');
};

export const attachmentFileActions = async (region: Locator, path: string): Promise<Locator> =>
  (await attachmentFileButton(region, path)).locator('..').locator('.attachment-actions-trigger');
