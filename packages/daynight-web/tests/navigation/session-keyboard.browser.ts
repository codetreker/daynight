import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openKeyboardSession } from '../helpers/sessionKeyboard';

async function installViewport(page: Page) {
  await page.addInitScript(() => {
    const errors: { message: string; fullscreen: boolean; displayMenu: boolean }[] = [];
    Object.defineProperty(window, '__sessionKeyboardErrors', { value: errors });
    window.addEventListener('error', event => errors.push({ message: event.message, fullscreen: document.querySelector('[data-session-fullscreen="true"]') !== null, displayMenu: document.querySelector('.session-display-menu') !== null }));
    const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
}
async function visual(page: Page, width: number, height: number, top: number, left = 0) {
  await page.evaluate(values => {
    Object.assign(window.visualViewport!, { width: values.width, height: values.height, offsetTop: values.top, offsetLeft: values.left, pageTop: values.top, pageLeft: values.left });
    window.visualViewport!.dispatchEvent(new Event('resize'));
    window.visualViewport!.dispatchEvent(new Event('scroll'));
  }, { width, height, top, left });
}
async function geometry(page: Page) {
  return page.locator('[data-session-fullscreen="true"]').evaluate(root => {
    const rect = (element: Element) => element.getBoundingClientRect().toJSON();
    return { root: rect(root), header: rect(root.querySelector('.session-header')!), composer: rect(root.querySelector('.session-composer')!),
      color: getComputedStyle(root).backgroundColor, width: innerWidth, height: innerHeight };
  });
}

async function beforeFullscreen(page: Page, observations: Awaited<ReturnType<typeof openKeyboardSession>>['observations'], info: TestInfo, entry: string) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const errors = [...observations.pageErrors];
  const atError = await page.evaluate(() => (window as unknown as { __sessionKeyboardErrors: { message: string; fullscreen: boolean; displayMenu: boolean }[] }).__sessionKeyboardErrors);
  await info.attach('before-fullscreen-errors', { body: JSON.stringify({ phases: observations.pageErrorPhases, atError }), contentType: 'application/json' });
  // WebKit can report this existing Task/Bot draft resize warning before fullscreen
  // is enabled. Keep its evidence separate; no new warning is allowed afterward.
  if ((entry === 'assistant' || entry === 'task') && info.project.name === 'webkit') {
    expect(errors.length).toBeLessThanOrEqual(1);
    expect(atError.length).toBe(errors.length);
    expect(atError.every(error => !error.fullscreen && !error.displayMenu)).toBe(true);
    expect(errors.every(error => error === 'ResizeObserver loop completed with undelivered notifications.')).toBe(true);
  } else expect(errors).toEqual([]);
  return errors;
}

for (const entry of ['task', 'dialog', 'test', 'assistant'] as const) test(`${entry} covers the layout viewport while content follows keyboard offsets`, async ({ page }, info) => {
  await installViewport(page);
  const { observations } = await openKeyboardSession(page, entry);
  observations.phase = 'opened';
  const input = page.locator('.session-composer textarea');
  const draft = 'Retained draft 中文输入\n'.repeat(12);
  observations.phase = 'fill-draft';
  await input.fill(draft);
  const original = await input.elementHandle();
  const preFullscreenErrors = await beforeFullscreen(page, observations, info, entry);
  observations.phase = 'enter-fullscreen';
  await page.locator('.session-fullscreen-toggle').click();
  await input.evaluate(node => { (node as HTMLTextAreaElement).setSelectionRange(3, 10); node.focus(); });
  await input.dispatchEvent('compositionstart', { data: '中' });
  const reads = observations.currentReads, channels = observations.channels;
  const evidence = [];
  for (const [width, height, top, left] of [[390, 430, 0, 0], [350, 390, 70, 20], [350, 320, 95, 20], [390, 844, 0, 0]]) {
    observations.phase = `viewport-${width}-${height}-${top}-${left}`;
    await visual(page, width!, height!, top!, left!);
    await expect.poll(async () => (await geometry(page)).root).toEqual({ x: 0, y: 0, width: 390, height: 844, top: 0, right: 390, bottom: 844, left: 0 });
    const boxes = await geometry(page); evidence.push(boxes);
    expect(boxes.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(boxes.header.top).toBeGreaterThanOrEqual(top! - 1);
    expect(boxes.header.bottom).toBeLessThanOrEqual(top! + height! + 1);
    expect(boxes.composer.bottom).toBeLessThanOrEqual(top! + height! + 1);
    expect(boxes.composer.left).toBeGreaterThanOrEqual(left! - 1);
    expect(boxes.composer.right).toBeLessThanOrEqual(left! + width! + 1);
    expect(await input.evaluate((node, saved) => node === saved, original)).toBe(true);
    await expect(input).toHaveValue(draft); await expect(input).toBeFocused();
    expect(await input.evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd])).toEqual([3, 10]);
  }
  await input.dispatchEvent('compositionend', { data: '中' });
  observations.phase = 'rotate';
  await page.setViewportSize({ width: 844, height: 390 });
  await visual(page, 804, 300, 30, 20);
  await expect.poll(async () => (await geometry(page)).root).toEqual({ x: 0, y: 0, width: 844, height: 390, top: 0, right: 844, bottom: 390, left: 0 });
  const rotated = await geometry(page); evidence.push(rotated);
  expect(rotated.header.top).toBeGreaterThanOrEqual(29);
  expect(rotated.composer.bottom).toBeLessThanOrEqual(331);
  await page.setViewportSize({ width: 390, height: 844 });
  await visual(page, 350, 390, 70, 20);
  observations.phase = 'display-menu';
  await page.locator('.session-display-trigger').click();
  const display = page.locator('.session-display-menu');
  await expect(display).toBeVisible();
  const menu = (await display.boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(20); expect(menu.y).toBeGreaterThanOrEqual(70);
  expect(menu.x + menu.width).toBeLessThanOrEqual(370); expect(menu.y + menu.height).toBeLessThanOrEqual(460);
  await page.keyboard.press('Escape');
  await expect(display).toHaveCount(0);
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('keyboard-offset.png') });
  await visual(page, 350, 160, 70, 20);
  observations.phase = 'display-menu';
  await page.locator('.session-display-trigger').click();
  await expect(display).toBeVisible();
  const shortMenu = (await display.boundingBox())!;
  expect(shortMenu.y).toBeGreaterThanOrEqual(70); expect(shortMenu.y + shortMenu.height).toBeLessThanOrEqual(230);
  await page.keyboard.press('Escape');
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'true');
  observations.phase = 'exit-fullscreen';
  await visual(page, 390, 844, 0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.session-fullscreen-toggle')).toBeFocused();
  expect(await input.evaluate((node, saved) => node === saved, original)).toBe(true);
  await expect(input).toHaveValue(draft);
  expect(observations.currentReads).toBe(reads); expect(observations.channels).toBe(channels);
  expect(observations.writes).toEqual([]); expect(observations.pageErrors, JSON.stringify(observations.pageErrorPhases)).toEqual(preFullscreenErrors);
  await info.attach('viewport-evidence', { body: JSON.stringify({ boundary: 'Production App and Session with HTTP/WebSocket fixtures and synthetic visualViewport; no physical keyboard, iPhone, IME candidate UI or Provider validation.', evidence }), contentType: 'application/json' });
});

async function backgroundPositions(page: Page) {
  return page.locator('[data-session-fullscreen="true"]').evaluate(root => {
    const positions = [];
    for (let node = root.parentElement; node; node = node.parentElement) positions.push({ tag: node.tagName, classes: node.className, top: node.scrollTop, left: node.scrollLeft });
    return { window: [scrollX, scrollY], positions };
  });
}
async function touchMove(page: Page, selector: string, fromY: number, toY: number, fingers = 1) {
  return page.locator(selector).evaluate((target, { fromY, toY, fingers }) => {
    const emit = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touches = Array.from({ length: fingers }, (_, index) => ({ identifier: index, clientX: 60 + index * 10, clientY: y, target }));
      Object.defineProperty(event, 'touches', { value: touches });
      Object.defineProperty(event, 'changedTouches', { value: touches });
      target.dispatchEvent(event); return event.defaultPrevented;
    };
    emit('touchstart', fromY); const canceled = emit('touchmove', toY); emit('touchend', toY); return canceled;
  }, { fromY, toY, fingers });
}

for (const entry of ['task', 'dialog', 'test', 'assistant'] as const) test(`${entry} keeps legal scrolling and blocks chaining outside the Session`, async ({ page }, info) => {
  await installViewport(page);
  const { observations } = await openKeyboardSession(page, entry);
  observations.phase = 'opened';
  const input = page.locator('.session-composer textarea');
  observations.phase = 'fill-draft';
  await input.fill('Long unsent draft 中文草稿\n'.repeat(60));
  const preFullscreenErrors = await beforeFullscreen(page, observations, info, entry);
  observations.phase = 'enter-fullscreen';
  await page.locator('.session-fullscreen-toggle').click();
  await visual(page, 390, 600, 40);
  await input.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(0, 0));
  const timeline = page.locator('.session-timeline');
  await timeline.evaluate(node => { node.scrollTop = 0; });
  const background = await backgroundPositions(page);
  await timeline.hover();
  const wheelTarget = await timeline.evaluate(node => {
    const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { hit: hit?.tagName, parent: hit?.parentElement?.tagName, parentOverflow: hit?.parentElement ? getComputedStyle(hit.parentElement).overflow : null,
      parentOverscroll: hit?.parentElement ? getComputedStyle(hit.parentElement).overscrollBehavior : null, timelineHeight: node.clientHeight, timelineScrollHeight: node.scrollHeight };
  });
  await info.attach('wheel-target', { body: JSON.stringify(wheelTarget), contentType: 'application/json' });
  await page.mouse.wheel(0, 180);
  await expect.poll(() => timeline.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await timeline.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await timeline.hover(); await page.mouse.wheel(0, 400);
  expect(await touchMove(page, '.session-timeline', 200, 150)).toBe(true);
  await timeline.evaluate(node => { node.scrollTop = 0; });
  await timeline.hover(); await page.mouse.wheel(0, -400);
  expect(await touchMove(page, '.session-timeline', 150, 200)).toBe(true);
  expect(await touchMove(page, '.session-timeline', 200, 150)).toBe(false);
  expect(await touchMove(page, '.session-header', 200, 150)).toBe(true);
  expect(await touchMove(page, '.session-header', 200, 150, 2)).toBe(false);
  await input.evaluate(node => { node.scrollTop = 0; });
  await input.hover(); await page.mouse.wheel(0, 120);
  await expect.poll(() => input.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await input.evaluate(node => { node.scrollTop = 10; });
  expect(await touchMove(page, '.session-composer textarea', 200, 180)).toBe(false);
  await page.locator('.session-command-trigger').click();
  const commands = page.locator('.session-command-body');
  await expect(commands).toBeVisible(); await commands.hover(); await page.mouse.wheel(0, 200);
  await expect.poll(() => commands.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await page.locator('.session-command-close').click();
  expect(await backgroundPositions(page)).toEqual(background);
  await page.keyboard.press('Escape');
  expect(await touchMove(page, '.session-header', 200, 150)).toBe(false);
  expect(observations.writes).toEqual([]); expect(observations.pageErrors, JSON.stringify(observations.pageErrorPhases)).toEqual(preFullscreenErrors);
  await info.attach('scroll-evidence', { body: JSON.stringify({ background, boundary: 'Trusted desktop wheel plus synthetic cancelable touch events on production DOM; synthetic touch validates event policy only, not native iOS gesture scrolling.' }), contentType: 'application/json' });
});

test('freezes and restores a nonzero root position without replacing the Test Session', async ({ page }, info) => {
  const { observations } = await openKeyboardSession(page, 'test');
  observations.phase = 'opened';
  const input = page.locator('.session-composer textarea');
  await input.fill('Retained draft at a nonzero page position');
  const original = await input.elementHandle();
  // The actual Test route normally fits the viewport. This test-only trailing
  // spacer makes its ancestor document scrollable while retaining production UI.
  await page.evaluate(() => {
    const spacer = document.createElement('div'); spacer.style.height = '1800px'; spacer.dataset.scrollFixture = 'true'; document.body.append(spacer);
    document.body.style.setProperty('color', 'rgb(20, 30, 40)', 'important');
    window.scrollTo({ top: 200, behavior: 'instant' });
  });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(200);
  const style = await page.evaluate(() => document.body.getAttribute('style'));
  const reads = observations.currentReads, channels = observations.channels;
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.locator('.session-fullscreen-toggle').evaluate(node => (node as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(() => ({ position: document.body.style.position, top: document.body.style.top }))).toEqual({ position: 'fixed', top: '-200px' });
    const locked = await page.evaluate(() => [scrollX, scrollY]);
    await page.locator('.session-header').hover(); await page.mouse.wheel(0, 500);
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(locked);
    await page.locator('.session-fullscreen-toggle').evaluate(node => (node as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(200);
    expect(await page.evaluate(() => document.body.getAttribute('style'))).toBe(style);
    expect(await input.evaluate((node, saved) => node === saved, original)).toBe(true);
    await expect(input).toHaveValue('Retained draft at a nonzero page position');
  }
  expect(observations.currentReads).toBe(reads); expect(observations.channels).toBe(channels);
  await page.locator('.session-fullscreen-toggle').evaluate(node => (node as HTMLButtonElement).click());
  await page.evaluate(() => { history.pushState(null, '', '/projects'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.locator('.session-fullscreen-toggle')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.getAttribute('style'))).toBe(style);
  expect(observations.writes).toEqual([]);
  await info.attach('root-scroll-boundary', { body: 'Production Test Session, artificial outer-page spacer, trusted desktop wheel; this verifies root style/position ownership and cleanup, not real software keyboard behavior.', contentType: 'text/plain' });
});
