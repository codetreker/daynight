import { expect, type Locator } from '@playwright/test';

export const expectLanguageLayout = async (selector: Locator): Promise<void> => {
  await expect(selector).toHaveAccessibleName('语言 / Language');
  await expect(selector).toBeVisible();
  const layout = await selector.evaluate((element: HTMLSelectElement) => {
    const control = element.closest('label');
    if (control === null) throw new Error('Language control is absent.');
    const style = getComputedStyle(element);
    const arrow = getComputedStyle(control, '::after');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas text measurement is unavailable.');
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const longest = Math.max(...[...element.options].map((option) => context.measureText(option.text).width));
    const bounds = element.getBoundingClientRect();
    return {
      label: control.textContent?.trim(),
      width: bounds.width,
      textSpace: bounds.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
        - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      longest,
      rightPadding: parseFloat(style.paddingRight),
      arrowInset: parseFloat(arrow.right),
      arrowWidth: parseFloat(arrow.width),
      arrowVisible: arrow.content !== 'none' && arrow.display !== 'none',
      left: bounds.left,
      right: bounds.right,
      viewport: window.innerWidth,
    };
  });
  expect(layout.label).not.toContain('语言 / Language');
  expect(layout.arrowVisible).toBe(true);
  expect(layout.arrowInset).toBeGreaterThanOrEqual(8);
  expect(layout.rightPadding).toBeGreaterThanOrEqual(layout.arrowInset + layout.arrowWidth + 5);
  expect(layout.textSpace + 0.5).toBeGreaterThanOrEqual(layout.longest);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewport);
};
