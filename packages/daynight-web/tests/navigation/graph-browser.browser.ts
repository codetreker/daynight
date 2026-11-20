import { expect, test } from '@playwright/test';
import { checkDependencyGeometry, expectedDependencyTopology } from '../helpers/dependency-geometry';
import { completeContextGraph } from '../helpers/graphData';

const rootId = '00000000-0000-4000-8000-000000000030';
const expected = expectedDependencyTopology(completeContextGraph.tasks, rootId);

test('retains real dependency geometry and viewport through direction, zoom, pan and fullscreen', async ({ page }, info) => {
  await page.goto('/tests/navigation/graph-browser.html');
  await page.getByRole('button', { name: 'Open graph' }).click();
  const dialog = page.locator('.task-chain-dialog');
  const viewport = page.locator('.react-flow__viewport');
  await expect(page.locator('.react-flow__node')).toHaveCount(expected.nodes.length);
  await expect(page.locator('.react-flow__edge')).toHaveCount(expected.edges.length);
  const cards = await page.locator('.react-flow__node').evaluateAll(elements => elements.map(element => {
    const card = element.querySelector<HTMLElement>('.task-node')!;
    const details = card.querySelector('.task-node-details')!.getBoundingClientRect();
    const title = card.querySelector('.task-node-title')!.getBoundingClientRect();
    const bottom = [...card.querySelectorAll('.task-node-bottom > *')].map(part => part.getBoundingClientRect());
    const controls = card.querySelector('.task-node-expansions')?.getBoundingClientRect();
    const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
    return { id: element.getAttribute('data-id'), width: card.offsetWidth, height: card.offsetHeight, hasControls: controls !== undefined,
      separate: bottom.every(part => separate(title, part) && separate(part, details) && (controls === undefined || separate(part, controls))) &&
        separate(title, details) && (controls === undefined || separate(details, controls)) };
  }));
  for (const card of cards) {
    const external = !expected.memberIds.includes(card.id!);
    expect(card).toEqual({ id: card.id, width: 300, height: external ? 184 : 124, hasControls: external, separate: true });
  }
  const geometry = async (direction: 'horizontal' | 'vertical') => {
    expect(await checkDependencyGeometry(page, expected, info, undefined, direction)).toEqual({ total: 0, examples: [] });
  };
  await geometry('horizontal');
  const node = page.locator('.react-flow__node').first().locator('button.task-node-body');
  await node.click();
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  const vertical = page.getByRole('radio', { name: '垂直', exact: true });
  await page.getByRole('radio', { name: '水平', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(vertical).toBeFocused();
  await expect(vertical).toHaveAttribute('aria-checked', 'true');
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  await geometry('vertical');
  const beforeZoom = await viewport.getAttribute('style');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforeZoom);
  await geometry('vertical');
  const bounds = (await page.locator('.react-flow').boundingBox())!;
  const beforePan = await viewport.getAttribute('style');
  await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down();
  await page.mouse.move(bounds.x + 80, bounds.y + 55, { steps: 4 }); await page.mouse.up();
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan);
  await geometry('vertical');
  const beforeFullscreen = await viewport.getAttribute('style');
  const element = await viewport.elementHandle();
  await page.getByRole('button', { name: '全屏查看', exact: true }).click();
  await expect(dialog).toHaveClass(/task-chain-dialog-fullscreen/);
  const fullscreen = (await dialog.boundingBox())!;
  expect(fullscreen).toEqual({ x: 0, y: 0, width: 1600, height: 1100 });
  await expect(viewport).toHaveAttribute('style', beforeFullscreen!);
  expect(await element!.evaluate(el => el === document.querySelector('.react-flow__viewport'))).toBe(true);
  await geometry('vertical');
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect(viewport).toHaveAttribute('style', beforeFullscreen!);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open graph' })).toBeFocused();
});

for (const rootSize of [16, 32]) test(`320px graph keeps its first card and controls usable at ${rootSize}px root`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/tests/navigation/graph-browser.html');
  await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
  await page.getByRole('button', { name: 'Open graph' }).click();
  const canvas = page.locator('.react-flow');
  const card = page.locator(`.react-flow__node[data-id="${rootId}"]`);
  await expect(card).toBeVisible();
  const body = card.locator('.task-node-body');
  await expect.poll(async () => card.evaluate(element => {
    const pane = element.closest('.react-flow')!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return box.left >= pane.left - 1 && box.right <= pane.right + 1 && box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1;
  })).toBe(true);
  await body.focus();
  await expect(body).toBeFocused();
  const sizes = await card.evaluate(element => {
    const card = element.querySelector<HTMLElement>('.task-node')!;
    const box = card.getBoundingClientRect();
    const parts = [...element.querySelectorAll('.task-node-title, .task-node-meta, .task-node-bottom, .task-external-label, .task-node-details, .task-node-expansions')].map(part => part.getBoundingClientRect());
    return { width: card.offsetWidth, height: card.offsetHeight,
      inside: parts.every(part => part.left >= box.left - 1 && part.right <= box.right + 1 && part.top >= box.top - 1 && part.bottom <= box.bottom + 1) };
  });
  expect(sizes).toEqual({ width: 300 * rootSize / 16, height: 124 * rootSize / 16, inside: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await body.press('Enter');
  await expect(body).toHaveAttribute('aria-pressed', 'true');
  const viewport = page.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
  await expect(canvas).toBeVisible();
});
