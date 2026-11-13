import { expect, type Locator } from '@playwright/test';

export const roleColors = {
  proposed: ['rgb(240, 235, 255)', 'rgb(229, 220, 255)', 'rgb(201, 184, 236)', 'rgb(100, 70, 156)'],
  todo: ['rgb(250, 251, 252)', 'rgb(240, 243, 247)', 'rgb(213, 220, 229)', 'rgb(82, 97, 116)'],
  in_progress: ['rgb(233, 241, 255)', 'rgb(220, 232, 255)', 'rgb(182, 206, 244)', 'rgb(40, 91, 159)'],
  done: ['rgb(234, 246, 239)', 'rgb(220, 238, 228)', 'rgb(185, 217, 197)', 'rgb(37, 106, 72)'],
  cancelled: ['rgb(233, 235, 238)', 'rgb(221, 225, 230)', 'rgb(191, 198, 206)', 'rgb(89, 97, 108)'],
  ended: ['rgb(241, 243, 245)', 'rgb(228, 232, 236)', 'rgb(201, 208, 215)', 'rgb(82, 96, 109)'],
  attention: ['rgb(255, 247, 232)', 'rgb(255, 240, 214)', 'rgb(212, 160, 74)', 'rgb(128, 91, 39)'],
  error: ['rgb(255, 240, 239)', 'rgb(255, 226, 223)', 'rgb(223, 157, 150)', 'rgb(163, 50, 43)'],
} as const;

export const expectTextContrast = async (target: Locator) => {
  const contrast = await target.evaluate(element => {
    const luminance = (value: string) => {
      const [r, g, b] = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => {
        const n = c / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    let background = element;
    while (getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)' && background.parentElement) background = background.parentElement;
    const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(background).backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast, await target.innerText()).toBeGreaterThanOrEqual(4.5);
};
