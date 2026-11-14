import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixture = '/tests/navigation/native-select-fixture.html';
const screenshot = async (page: Page, info: TestInfo, name: string) => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
};
const metrics = (control: Locator) => control.evaluate(element => {
  const select = element as HTMLSelectElement, wrapper = select.parentElement!, arrow = wrapper.querySelector('svg');
  const bounds = select.getBoundingClientRect(), outer = wrapper.getBoundingClientRect(), icon = arrow?.getBoundingClientRect();
  const style = getComputedStyle(select);
  return {
    height: bounds.height, width: bounds.width, left: bounds.left, right: bounds.right, outerHeight: outer.height,
    centerError: icon ? Math.abs((icon.top + icon.bottom - bounds.top - bounds.bottom) / 2) : null,
    endGap: icon ? style.direction === 'rtl' ? icon.left - bounds.left : bounds.right - icon.right : null,
    arrowWidth: icon?.width, arrowHeight: icon?.height, arrowCount: wrapper.querySelectorAll('svg').length,
    appearance: style.appearance, paddingEnd: Number.parseFloat(style.paddingInlineEnd), fontSize: style.fontSize,
    border: style.borderColor, background: style.backgroundColor, color: style.color, outline: style.outlineColor,
    outlineWidth: style.outlineWidth, arrowColor: arrow ? getComputedStyle(arrow).color : null,
    selectedIndex: select.selectedIndex, selected: [...select.selectedOptions].map(option => option.value),
  };
});

const expectPopupGeometry = async (control: Locator, height: number) => {
  const actual = await metrics(control);
  expect(actual.height).toBe(height); expect(actual.outerHeight).toBe(height);
  expect(actual.arrowWidth).toBe(10); expect(actual.arrowHeight).toBe(10); expect(actual.arrowCount).toBe(1);
  expect(actual.centerError).toBeLessThanOrEqual(1); expect(Math.abs(actual.endGap! - 12)).toBeLessThanOrEqual(1);
  expect(actual.paddingEnd).toBeGreaterThanOrEqual(30); expect(actual.appearance).toBe('none');
  expect(actual.paddingEnd - actual.endGap! - actual.arrowWidth!).toBeGreaterThanOrEqual(8);
  expect(actual.width).toBeGreaterThan(40);
  return actual;
};

const expectNoOverflow = async (page: Page) => {
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const bounds = await page.locator('select:visible').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right };
  }));
  const width = await page.evaluate(() => innerWidth);
  for (const rect of bounds) { expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(width + 1); }
};

for (const locale of ['en', 'zh']) {
  test(`keeps ${locale} variants, states and long labels aligned across viewport widths`, async ({ page }, info) => {
    await page.goto(`${fixture}?locale=${locale}`);
    const observations: unknown[] = [];
    for (const [width, height] of [[320, 640], [375, 667], [390, 844], [768, 900], [1280, 900], [1360, 900]] as const) {
      await page.setViewportSize({ width, height });
      for (const [density, expectedHeight] of [['compact', 24], ['filter', 32], ['form', 38]] as const) {
        for (const state of ['normal', 'disabled', 'fieldset', 'pending', 'invalid', 'long', 'empty']) {
          const control = page.getByTestId(`${density}-${state}`);
          const actual = await expectPopupGeometry(control, expectedHeight);
          observations.push({ viewportWidth: width, density, state, ...actual });
          if (state === 'empty') { expect(actual.selectedIndex).toBe(-1); await expect(control.locator('option')).toHaveCount(2); }
          if (state === 'disabled' || state === 'fieldset') { await expect(control).toBeDisabled(); expect(actual.arrowColor).toBe(actual.color); }
          if (state === 'pending') expect(actual.border).toBe('rgb(212, 160, 74)');
          if (state === 'invalid') expect(actual.border).toBe('rgb(223, 157, 150)');
          if (state === 'long') expect(await control.locator('option:checked').textContent()).toContain(locale === 'zh' ? '很长动态选项' : 'long dynamic');
        }
      }
      for (const name of ['flex', 'grid', 'fixed', 'fixed-fill', 'rtl']) await expectPopupGeometry(page.getByTestId(name), 38);
      expect((await metrics(page.getByTestId('fixed'))).width).toBe(150);
      expect((await metrics(page.getByTestId('fixed-fill'))).width).toBe(150);
      await expectNoOverflow(page);
      if (width === 320 || width === 1360) await screenshot(page, info, `${locale}-${width}`);
    }
    await expect(page.getByTestId('hidden')).toBeHidden();
    await expect(page.getByTestId('hidden').locator('..')).toBeHidden();
    await info.attach('rendered-geometry', { body: JSON.stringify(observations), contentType: 'application/json' });
  });
}

test('preserves native list rows, multiple selection, fieldset and focus states', async ({ page }, info) => {
  await page.goto(fixture);
  for (const name of ['single-list', 'multiple-list']) {
    const actual = await metrics(page.getByTestId(name));
    expect(actual.arrowCount).toBe(0); expect(actual.paddingEnd).toBe(10); expect(actual.height).toBeGreaterThan(38);
  }
  expect((await metrics(page.getByTestId('multiple-list'))).selected).toEqual(['a', 'b']);
  await expect(page.getByTestId('single-list')).toHaveAttribute('size', '3');
  await expect(page.getByTestId('multiple-list')).toHaveAttribute('size', '4');
  await page.getByTestId('form-normal').focus();
  expect(await metrics(page.getByTestId('form-normal'))).toMatchObject({ outlineWidth: '3px', outline: 'rgb(140, 140, 240)' });
  await page.getByTestId('task-focus').focus();
  expect(await metrics(page.getByTestId('task-focus'))).toMatchObject({ outlineWidth: '3px', outline: 'rgb(52, 64, 84)', border: 'rgb(212, 160, 74)' });
  await screenshot(page, info, 'lists-and-focus');
});

test('opens the native popup through the arrow and accepts real keyboard choice without remounting', async ({ page }, info) => {
  await page.goto(fixture);
  const control = page.getByTestId('interactive');
  await expect(control).toHaveAccessibleName('Interactive field');
  await expect(control).toHaveAccessibleDescription('Native pointer and keyboard input.');
  await page.getByTestId('before').focus(); await page.keyboard.press('Tab'); await expect(control).toBeFocused();
  await control.evaluate(element => element.setAttribute('data-node-marker', 'original'));
  await control.scrollIntoViewIfNeeded();
  const arrow = await control.locator('..').locator('svg').boundingBox();
  expect(arrow).not.toBeNull();
  await page.mouse.click(arrow!.x + arrow!.width / 2, arrow!.y + arrow!.height / 2);
  await expect.poll(() => control.evaluate(element => element.matches(':open'))).toBe(true);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(control).toHaveValue('b'); await expect(page.getByTestId('changes')).toHaveText('1');
  await expect(control).toHaveAttribute('data-node-marker', 'original');
  await page.getByTestId('rerender').dispatchEvent('click');
  await expect(control).toHaveAttribute('data-node-marker', 'original'); await expect(control).toHaveValue('b');
  await expect(control).toBeFocused(); await expect(page.getByTestId('changes')).toHaveText('1');
  await info.attach('native-input', { body: JSON.stringify({ pointer: 'Arrow center opened :open', keyboard: 'ArrowDown + Enter selected b', changes: 1, sameNode: true, browser: await page.context().browser()!.version() }), contentType: 'application/json' });
});

test('retains browser required validation and prevents an empty form submission', async ({ page }) => {
  await page.goto(fixture);
  const control = page.getByTestId('required');
  await page.getByRole('button', { name: 'Submit native form' }).click();
  await expect(control).toBeFocused(); await expect(page.getByTestId('submissions')).toHaveText('0');
  expect(await control.evaluate(element => (element as HTMLSelectElement).validity.valueMissing)).toBe(true);
  await control.selectOption('a'); await page.getByRole('button', { name: 'Submit native form' }).click();
  await expect(page.getByTestId('submissions')).toHaveText('1');
});

test('uses the named container rather than viewport or a nearer unrelated container', async ({ page }, info) => {
  await page.goto(fixture);
  await expectPopupGeometry(page.getByTestId('wide-container'), 38);
  await expectPopupGeometry(page.getByTestId('narrow-container'), 44);
  expect((await metrics(page.getByTestId('narrow-container'))).fontSize).toBe('12px');
  expect(await page.getByTestId('container-wide').evaluate(element => getComputedStyle(element).containerName)).toBe('bot-reading native-select-region');
  await expectPopupGeometry(page.getByTestId('responsive'), 38);
  await page.setViewportSize({ width: 768, height: 900 });
  const responsive = await expectPopupGeometry(page.getByTestId('responsive'), 44); expect(responsive.fontSize).toBe('16px');
  await expectPopupGeometry(page.getByTestId('compact-normal'), 24);
  await screenshot(page, info, 'named-container');
});

test('uses coarse-pointer touch dimensions without enlarging ordinary fields', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
  try {
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:14301${fixture}`);
    expect(await page.evaluate(() => matchMedia('(pointer:coarse)').matches)).toBe(true);
    for (const name of ['responsive', 'wide-container', 'narrow-container']) {
      const actual = await expectPopupGeometry(page.getByTestId(name), 44); expect(actual.fontSize).toBe('16px');
    }
    await expectPopupGeometry(page.getByTestId('compact-normal'), 24);
    const responsive = page.getByTestId('responsive'); await responsive.scrollIntoViewIfNeeded();
    const bounds = await responsive.boundingBox(); expect(bounds).not.toBeNull();
    await page.touchscreen.tap(bounds!.x + bounds!.width - 17, bounds!.y + bounds!.height / 2);
    await expect.poll(() => responsive.evaluate(element => element.matches(':open'))).toBe(true);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await expect(responsive).toHaveValue('b');
    await screenshot(page, info, 'coarse-pointer');
  } finally { await context.close(); }
});

test('keeps focus, disabled text and arrow visible in forced colors', async ({ page }, info) => {
  await page.emulateMedia({ forcedColors: 'active' }); await page.goto(fixture);
  await page.getByTestId('form-normal').focus();
  const normal = await metrics(page.getByTestId('form-normal'));
  for (const name of ['form-normal', 'form-disabled', 'form-fieldset', 'form-pending', 'form-invalid']) {
    const actual = await expectPopupGeometry(page.getByTestId(name), 38);
    expect(actual.color).not.toBe(actual.background); expect(actual.arrowColor).toBe(actual.color);
    expect(actual.border).not.toBe('rgba(0, 0, 0, 0)');
    if (name === 'form-pending' || name === 'form-invalid') expect(actual.border).toBe(normal.border);
  }
  expect((await metrics(page.getByTestId('form-normal'))).outlineWidth).toBe('3px');
  await screenshot(page, info, 'forced-colors');
});

test('remains usable at actual 200% browser page zoom', async ({ playwright }, info) => {
  const temporary = fileURLToPath(new URL('../../../../.tmp/native-select-browser/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  const profile = await mkdtemp(`${temporary}/zoom-profile-`);
  try {
    await mkdir(`${profile}/Default`);
    // Chromium stores native page zoom as a logarithmic level under the default
    // partition key "x": https://github.com/chromium/chromium/blob/114f7fa6d7fe2cfe3860cc634d4751fc84fc7ab5/chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc#L32-L38
    await writeFile(`${profile}/Default/Preferences`, JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
    const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
    const context = await playwright.chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, viewport: null, args: ['--window-size=1280,900', '--force-device-scale-factor=1'],
      ...(executable === undefined ? {} : { executablePath: executable }),
    });
    try {
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:14301${fixture}?locale=zh`);
      const zoom = await page.evaluate(() => ({ ratio: devicePixelRatio, width: innerWidth, screenWidth: outerWidth, cssZoom: getComputedStyle(document.documentElement).zoom, visualScale: visualViewport!.scale }));
      expect(zoom.ratio).toBeCloseTo(2, 1); expect(zoom.width).toBeLessThan(800);
      expect(zoom.cssZoom).toBe('1'); expect(zoom.visualScale).toBe(1);
      await expectNoOverflow(page); await expectPopupGeometry(page.getByTestId('form-long'), 38);
      await page.getByTestId('required').selectOption('b'); await page.getByRole('button', { name: 'Submit native form' }).click();
      await expect(page.getByTestId('submissions')).toHaveText('1');
      await info.attach('browser-200-percent-zoom', { body: JSON.stringify(zoom), contentType: 'application/json' });
      await screenshot(page, info, 'browser-200-percent-render');
    } finally { await context.close(); }
  } finally { await rm(profile, { recursive: true, force: true }); }
});
