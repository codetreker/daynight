import { expect, type Page } from '@playwright/test';

/** Measure the product header, including narrow columns in a wide workspace. */
export async function expectBotHeading(page: Page) {
  const heading = page.locator('.bot-conversation-heading');
  await expect(heading.locator('.bot-details-toggle')).toBeVisible();
  const read = () => heading.evaluate(element => {
    const rect = (node: Element) => node.getBoundingClientRect().toJSON();
    const toggle = element.querySelector('.bot-details-toggle')!;
    return {
      heading: rect(element), close: rect(element.querySelector('a')!),
      title: rect(element.querySelector('h2')!), toggle: rect(toggle),
      marker: rect(toggle.querySelector('[aria-hidden]')!),
      fontSize: getComputedStyle(element.querySelector('h2')!).fontSize,
      overflow: element.scrollWidth > element.clientWidth,
      statusOverflow: [...element.querySelectorAll('.bot-status > span')].some(node => {
        const child = node.getBoundingClientRect(), parent = element.getBoundingClientRect();
        return child.left < parent.left - 1 || child.right > parent.right + 1;
      }),
    };
  });
  await expect.poll(async () => {
    const bounds = await read();
    return !bounds.overflow && !bounds.statusOverflow
      && bounds.marker.right <= bounds.toggle.right + 1
      && bounds.marker.left >= bounds.toggle.left - 1
      && (bounds.heading.width <= 420
        ? bounds.title.top >= bounds.close.bottom && Math.abs(bounds.title.width - bounds.heading.width) <= 1
        : bounds.title.left >= bounds.close.right);
  }, { message: 'The name must use the full narrow header width without competing with close or overflowing.' }).toBe(true);
  const bounds = await read();
  expect(bounds.fontSize).toBe('19px');
  return bounds;
}
