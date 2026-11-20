import { expect, type Locator } from '@playwright/test';

export async function expectGraphCardBadges(card: Locator) {
  const badges = card.locator('.task-node-meta-labels > *');
  await expect(badges).toHaveCount(3);
  const result = await badges.evaluateAll(elements => {
    const boxes = elements.map(element => element.getBoundingClientRect());
    const parent = elements[0]!.parentElement!.getBoundingClientRect();
    const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
    const rows: number[] = [];
    for (const box of boxes) if (!rows.some(top => Math.abs(top - box.top) < 1)) rows.push(box.top);
    return { rows: rows.length, inside: boxes.every(box => box.left >= parent.left - 1 && box.right <= parent.right + 1 && box.top >= parent.top - 1 && box.bottom <= parent.bottom + 1),
      separate: boxes.every((box, index) => boxes.slice(index + 1).every(other => separate(box, other))),
      unclipped: elements.every(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) };
  });
  expect(result.inside).toBe(true);
  expect(result.separate).toBe(true);
  expect(result.unclipped).toBe(true);
  expect(result.rows).toBe(1);
}
