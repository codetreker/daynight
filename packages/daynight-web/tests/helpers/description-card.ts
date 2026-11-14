import { expect, type Locator, type Page } from '@playwright/test';

export async function expectDescriptionCard(page: Page, card: Locator, width: number) {
  await expect(card).toBeVisible();
  const style = await card.evaluate(element => {
    const css = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const content = element.firstElementChild!.getBoundingClientRect();
    return { border: css.borderTop, radius: css.borderRadius, padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft], contained: content.left >= box.left && content.right <= box.right };
  });
  expect(style).toEqual({ border: '1px solid rgb(213, 220, 229)', radius: '7px', padding: width <= 600 ? ['12px', '12px', '12px', '12px'] : ['16px', '18px', '16px', '18px'], contained: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
