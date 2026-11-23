import { expect, type Locator, type Page } from '@playwright/test';

// Measure the rendered consumer, including surrounding styles and layout.
export async function expectCopyButtonSkin(page: Page, button: Locator, labelled = false, iconSize = 26) {
  await button.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const measure = () => button.evaluate(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    const parent = element.parentElement!.getBoundingClientRect();
    const icon = element.querySelector('svg')!, iconBox = icon.getBoundingClientRect();
    return { background: style.backgroundColor, border: style.borderTopColor, shadow: style.boxShadow,
      width: box.width, height: box.height, parent: [parent.x, parent.y, parent.width, parent.height],
      icon: [iconBox.width, iconBox.height], outline: [style.outlineWidth, style.outlineStyle, style.outlineColor, style.outlineOffset] };
  });
  await expect(button).toHaveAttribute('type', 'button');
  await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(async () => (await measure()).background).toBe('rgba(0, 0, 0, 0)');
  const idle = await measure();
  expect(idle).toMatchObject({ background: 'rgba(0, 0, 0, 0)', border: 'rgba(0, 0, 0, 0)', shadow: 'none', icon: [16, 16] });
  if (!labelled) expect([idle.width, idle.height]).toEqual([iconSize, iconSize]);
  await button.hover();
  await expect.poll(async () => (await measure()).border).toBe('rgb(220, 224, 232)');
  const hover = await measure();
  expect(hover.background).toBe('rgb(255, 255, 255)');
  expect([hover.width, hover.height, hover.parent]).toEqual([idle.width, idle.height, idle.parent]);
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab'); await button.focus();
  expect((await measure()).outline).toEqual(['3px', 'solid', 'rgb(52, 64, 84)', '2px']);
}

export async function expectDisabledCopyHover(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await button.hover({ force: true });
  await expect.poll(() => button.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.borderTopColor, style.boxShadow];
  })).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'none']);
}
