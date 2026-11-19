import { expect, type Locator } from '@playwright/test';

export async function expectChartLabelsFit(scroll: Locator) {
  const geometry = await scroll.evaluate(element => {
    element.scrollTop = 100;
    const labels = element.querySelector('.bar-chart__labels')!;
    const bounds = labels.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      labelsFit: [...labels.querySelectorAll('span')].every(label => {
        const box = label.getBoundingClientRect();
        return box.top >= bounds.top - 0.02 && box.bottom <= bounds.bottom + 0.02;
      }),
    };
  });
  expect(geometry.scrollHeight).toBe(geometry.clientHeight);
  expect(geometry.scrollTop).toBe(0);
  expect(geometry.labelsFit).toBe(true);
}
