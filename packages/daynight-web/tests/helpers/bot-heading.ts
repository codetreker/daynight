import { expect, type Locator, type Page } from '@playwright/test';

const detailsName = /^(Assistant details|Details|助手详情|详情)$/;
const closeName = /^(Close conversation|Back to assistants|Back to list|关闭对话|返回助手列表|返回列表)$/;

/** Resolve the same user action before and after the title and details entry are separated. */
export function botDetailsOpener(page: Page, name: string) {
  const conversation = page.locator('.bot-conversation');
  return conversation.getByRole('button', { name: detailsName }).or(conversation.getByRole('button', { name, exact: true }));
}

export function botDetails(page: Page) {
  return page.getByRole('dialog', { name: /^(Assistant details|助手详情)$/ })
    .or(page.getByRole('complementary', { name: /^(Assistant details|助手详情)$/ }));
}

/** Close only the reading selection, through either the direct entry or its menu. */
export async function closeBotConversation(page: Page) {
  const conversation = page.locator('.bot-conversation');
  const direct = conversation.getByRole('link', { name: closeName }).or(conversation.getByRole('button', { name: closeName }));
  if (await direct.isVisible()) { await direct.click(); return; }
  await conversation.getByRole('button', { name: /^(More|More actions|更多|更多操作)$/ }).click();
  await page.getByRole('menuitem', { name: closeName }).click();
}

export function botConversationBack(page: Page) {
  const conversation = page.locator('.bot-conversation');
  return conversation.getByRole('link', { name: closeName }).or(conversation.getByRole('button', { name: closeName }));
}

export function botCreationForm(page: Page) {
  return page.locator('form').filter({ has: page.getByRole('textbox', { name: /^(Name|名称)$/ }) });
}

export async function expectBotDetailsMode(page: Page, expected?: 'modal' | 'nonmodal') {
  const details = botDetails(page);
  await expect(details).toHaveCount(1);
  await expect(details).toBeVisible();
  const modal = await details.evaluate(node => node.matches(':modal'));
  if (expected !== undefined) expect(modal).toBe(expected === 'modal');
  if (modal) {
    await expect(details).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Tab');
    expect(await details.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await details.evaluate(node => node.contains(document.activeElement))).toBe(true);
  } else {
    await expect(details).toHaveAttribute('role', 'complementary');
    await expect(details).not.toHaveAttribute('aria-modal', 'true');
  }
  return details;
}

/** Read complete detail text through the panel, including wrapped names and machine identifiers. */
export async function expectBotDetailText(details: Locator, text: string) {
  const value = details.getByText(text, { exact: true });
  await expect(value).toBeVisible();
  await value.scrollIntoViewIfNeeded();
  const geometry = await value.evaluate(node => {
    const panel = node.closest('dialog, [role="dialog"], [role="complementary"]')!;
    const range = document.createRange(); range.selectNodeContents(node);
    return { text: range.getBoundingClientRect().toJSON(), panel: panel.getBoundingClientRect().toJSON(),
      clipped: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight };
  });
  expect(geometry.clipped).toBe(false);
  expect(geometry.text.left).toBeGreaterThanOrEqual(geometry.panel.left - 1);
  expect(geometry.text.right).toBeLessThanOrEqual(geometry.panel.right + 1);
}

export async function focusBotControl(page: Page, control: Locator) {
  await expect(control).toHaveCount(1);
  for (let index = 0; index < 40; index++) {
    if (await control.evaluate(node => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard did not reach the assistant control.');
}

/** Controls must remain reachable and unclipped regardless of title wrapping or font size. */
export async function expectBotHeading(page: Page, name: string) {
  const opener = botDetailsOpener(page, name);
  await expect(opener).toHaveCount(1);
  await expect(opener).toBeVisible();
  await expect(opener).toBeEnabled();
  const read = () => opener.evaluate(element => {
    const heading = element.closest('header')!;
    const rect = (node: Element) => node.getBoundingClientRect().toJSON();
    const controls = [...heading.querySelectorAll<HTMLElement>('a, button')]
      .filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
      .map(node => ({ label: node.getAttribute('aria-label') ?? node.textContent, ...rect(node) }));
    return { heading: rect(heading), controls, width: innerWidth, overflow: heading.scrollWidth > heading.clientWidth };
  });
  await expect.poll(async () => {
    const bounds = await read();
    return !bounds.overflow && bounds.controls.every((control, index) => control.width > 0 && control.height > 0
      && control.left >= bounds.heading.left - 1 && control.right <= bounds.heading.right + 1
      && control.left >= -1 && control.right <= bounds.width + 1
      && bounds.controls.slice(index + 1).every(other => control.right <= other.left + 1 || other.right <= control.left + 1
        || control.bottom <= other.top + 1 || other.bottom <= control.top + 1));
  }, { message: 'Assistant title actions must remain inside the header without overlapping.' }).toBe(true);
  await opener.click({ trial: true });
  return read();
}
