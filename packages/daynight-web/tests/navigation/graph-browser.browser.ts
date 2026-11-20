import { expect, test } from '@playwright/test';
import { checkDependencyGeometry, expectedDependencyTopology } from '../helpers/dependency-geometry';
import { completeContextGraph } from '../helpers/graphData';

const rootId = '00000000-0000-4000-8000-000000000030';
const expected = expectedDependencyTopology(completeContextGraph.tasks, rootId);

for (const rootSize of [12, 16, 24]) test(`graph text and geometry remain independent of view zoom at ${rootSize}px root`, async ({ page }, info) => {
  await page.goto('/tests/navigation/graph-browser.html');
  await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
  await page.getByRole('button', { name: 'Open graph' }).click();
  const card = page.locator(`.react-flow__node[data-id="${rootId}"] .task-node`);
  const body = card.locator('.task-node-body');
  await expect(card).toBeVisible();
  await expect(card.locator('.task-node-title')).toHaveCSS('font-size', `${rootSize * 0.875}px`);
  await expect(card.locator('.task-node-meta')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
  await expect(page.locator('.task-chain-meta')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
  await expect(page.locator('.task-chain-meta > .graph-status')).toHaveCSS('font-size', `${rootSize * 0.875}px`);
  await expect.poll(() => card.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(300 * Math.max(rootSize / 16, 1));
  await body.focus();
  await body.press('Enter');
  await expect(body).toHaveAttribute('aria-pressed', 'true');
  await expect(body).toBeFocused();
  for (const [direction, name] of [['horizontal', '水平'], ['vertical', '垂直']] as const) {
    await page.getByRole('radio', { name, exact: true }).click();
    await expect.poll(() => checkDependencyGeometry(page, expected, info, undefined, direction)).toEqual({ total: 0, examples: [] });
    await expect(body).toHaveAttribute('aria-pressed', 'true');
  }
  const before = await card.evaluate(element => ({ width: (element as HTMLElement).offsetWidth, painted: element.getBoundingClientRect().width }));
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect.poll(() => card.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(before.painted);
  expect(await card.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(before.width);
  await expect(card.locator('.task-node-title')).toHaveCSS('font-size', `${rootSize * 0.875}px`);
  expect(await checkDependencyGeometry(page, expected, info, undefined, 'vertical')).toEqual({ total: 0, examples: [] });
});

for (const width of [1600, 320]) test(`successor inspection preserves the real chain viewport at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1100 });
  await page.goto('/tests/navigation/graph-browser.html');
  await page.getByRole('button', { name: 'Open graph' }).click();
  const selected = page.locator(`.react-flow__node[data-id="${rootId}"] .task-node-body`);
  const successor = page.locator('.react-flow__node[data-id="00000000-0000-4000-8000-000000000031"] .task-node');
  await expect(page.locator('.react-flow__node')).toHaveCount(expected.nodes.length);
  await expect(selected).toBeVisible();
  await selected.focus();
  const viewport = page.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  await selected.press('Enter');
  await expect(successor).toHaveAttribute('data-inspection', 'successor');
  await expect(successor).toHaveCSS('outline-color', 'rgb(8, 127, 140)');
  await expect(successor.locator('.task-node-body')).toHaveAccessibleName(/所选任务的后继/);
  const edge = page.locator(`.task-dependency-edge[data-source="${rootId}"]`);
  await expect(edge).toHaveAttribute('data-inspection', 'successor');
  await expect(edge.locator('.task-dependency-body')).toHaveCSS('stroke', 'rgb(8, 127, 140)');
  const marker = await edge.locator('.react-flow__edge-path').getAttribute('marker-end');
  await expect(page.locator(`[id="${marker!.slice(5, -1)}"] polyline`)).toHaveCSS('fill', 'rgb(8, 127, 140)');
  await expect(viewport).toHaveAttribute('style', before!);
  await expect(page.locator('.graph-successor-legend')).toHaveText('后继');
  await page.screenshot({ path: info.outputPath('successor-chain.png') });
  await selected.press('Enter');
  await expect(successor).toHaveAttribute('data-inspection', 'normal');
  await expect(viewport).toHaveAttribute('style', before!);
  const external = page.locator('.react-flow__node[data-id="00000000-0000-4000-8000-000000000017"] .task-node-body');
  await external.focus();
  const externalView = await viewport.getAttribute('style');
  await external.press('Enter');
  const dashed = page.locator('.task-dependency-edge[data-source="00000000-0000-4000-8000-000000000017"]');
  await expect(dashed).toHaveAttribute('data-inspection', 'successor');
  await expect(dashed).toHaveAttribute('data-external', 'true');
  await expect(dashed.locator('.task-dependency-paint-piece').first()).toHaveCSS('stroke-dasharray', /\d/);
  await expect(page.locator('.react-flow__node')).toHaveCount(expected.nodes.length);
  await expect(viewport).toHaveAttribute('style', externalView!);
  await external.press('Enter');
  await expect(successor).toHaveAttribute('data-inspection', 'normal');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

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
