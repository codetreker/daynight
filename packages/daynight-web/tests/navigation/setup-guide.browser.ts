import { expect, test } from '@playwright/test';
import { expectCopyButtonSkin, expectDisabledCopyHover } from './copy-button-assertions';

const origin = `https://${'a'.repeat(55)}.${'b'.repeat(55)}.example.test:4443`;

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('production setup guide remains public and usable across clients, languages and widths', async ({ page }, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (['fetch', 'xhr'].includes(request.resourceType())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/me') return route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'anonymous', requestId: 'fixture' } } });
    const response = await route.fetch({ url: `http://127.0.0.1:4210${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.goto(`${origin}/setup?ref=guide#cli`);
  await expect(page.locator('#mcp')).toBeVisible();
  await expect(page.locator('#cli')).toBeVisible();
  const client = page.locator('#setup-client');
  const language = page.getByRole('combobox', { name: '语言 / Language' });
  const clientNode = await client.elementHandle();
  const languageNode = await language.elementHandle();
  await expect(client).toHaveValue('codex');
  await expect(page.locator('#mcp .setup-command code').first()).toHaveText(`${origin}/mcp`);
  await client.focus();
  await page.keyboard.press('c');
  await page.keyboard.press('l');
  await expect(client).toHaveValue('claude');
  await language.selectOption('en');
  await expect(client).toHaveValue('claude');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const command = page.locator('#mcp .setup-command').nth(1);
  const rendered = await command.locator('code').textContent();
  const cliBefore = await page.locator('#cli').boundingBox();
  await command.getByRole('button').click();
  await expect(page.getByRole('status')).toContainText('Copied.');
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')).toBe(rendered);
  expect(await page.locator('#cli').boundingBox()).toEqual(cliBefore);
  await page.evaluate(() => {
    const state = window as unknown as { clipboard: Clipboard; finishCopy: () => void };
    state.clipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(resolve => { state.finishCopy = resolve; }) } });
  });
  await command.getByRole('button').click();
  const pendingButtons = page.locator('.setup-command .copy-button');
  for (const button of await pendingButtons.all()) await expect(button).toBeDisabled();
  await expectDisabledCopyHover(page, command.getByRole('button'));
  await page.evaluate(() => {
    const state = window as unknown as { clipboard: Clipboard; finishCopy: () => void };
    state.finishCopy(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: state.clipboard });
  });
  await expect(command.getByRole('button')).toBeEnabled();
  await page.locator('a[href="#mcp"]').click();
  await expect(page).toHaveURL(/#mcp$/);
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  for (const locale of ['zh-CN', 'en']) {
    await language.selectOption(locale);
    for (const value of ['codex', 'claude', 'copilot']) {
      await client.selectOption(value);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        if (value === 'codex') await expectCopyButtonSkin(page, page.locator('#mcp .setup-command').first().getByRole('button'), false, width === 320 ? 32 : 26);
        const geometry = await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          controls: [...document.querySelectorAll('.setup-guide a, .setup-guide button, .setup-guide select')].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({ left: rect.left, right: rect.right })),
        }));
        expect(geometry.width, `${locale}/${value}/${width}`).toBeLessThanOrEqual(width);
        for (const bounds of geometry.controls) { expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); }
        for (const [control, height] of [[client, 38], [language, 32]] as const) {
          const skin = await control.evaluate(element => {
            const wrapper = element.closest('.native-select')!;
            const arrow = wrapper.querySelector('.native-select__arrow')!;
            const box = element.getBoundingClientRect(), arrowBox = arrow.getBoundingClientRect();
            const style = getComputedStyle(element);
            return { height: box.height, fontSize: style.fontSize, appearance: style.appearance, paddingEnd: parseFloat(style.paddingInlineEnd), arrowWidth: arrowBox.width, arrowHeight: arrowBox.height, endGap: box.right - arrowBox.right, centerOffset: Math.abs(box.top + box.height / 2 - arrowBox.top - arrowBox.height / 2), pointerEvents: getComputedStyle(arrow).pointerEvents };
          });
          expect(skin).toMatchObject({ height, fontSize: '14px', appearance: 'none', arrowWidth: 10, arrowHeight: 10, pointerEvents: 'none' });
          expect(skin.paddingEnd).toBeGreaterThanOrEqual(30);
          expect(Math.abs(skin.endGap - 12)).toBeLessThanOrEqual(1);
          expect(skin.centerOffset).toBeLessThanOrEqual(1);
        }
        expect(await client.evaluate((element, initial) => element === initial, clientNode)).toBe(true);
        expect(await language.evaluate((element, initial) => element === initial, languageNode)).toBe(true);
        if ((locale === 'zh-CN' && value === 'codex' && [1440, 390].includes(width)) || (locale === 'en' && value === 'copilot' && width === 1440)) {
          await page.screenshot({ path: testInfo.outputPath(`${locale}-${value}-${width}.png`), fullPage: true });
        }
      }
    }
  }
  await page.reload();
  await expect(client).toHaveValue('codex');
  expect([...new Set(requests)]).toEqual([`${origin}/api/v1/me`]);
  expect(errors).toEqual([]);
});

for (const testOrigin of ['https://daynight.example', 'https://daynight.example:4443', 'http://localhost:4210', 'http://[::1]:4210']) {
  test(`derives the endpoint from ${testOrigin}`, async ({ page }) => {
    const requests: string[] = [];
    page.on('request', request => { if (['fetch', 'xhr'].includes(request.resourceType())) requests.push(request.url()); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== testOrigin) return route.abort();
      if (url.pathname === '/api/v1/me') return route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'anonymous', requestId: 'fixture' } } });
      const response = await route.fetch({ url: `http://127.0.0.1:4210${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    await page.goto(`${testOrigin}/setup`);
    await expect(page.locator('#mcp .setup-command code').first()).toHaveText(`${testOrigin}/mcp`);
    expect(requests).toEqual([`${testOrigin}/api/v1/me`]);
  });
}


test.describe('narrow setup steps', () => {
  test.use({ hasTouch: true });

  test('uses the available step width while preserving command interactions', async ({ page }) => {
    await page.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/v1/me') return route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'anonymous', requestId: 'fixture' } } });
      const response = await route.fetch({ url: `http://127.0.0.1:4210${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    await page.addInitScript(() => {
      const state = window as unknown as { copied: string; mode: string; finish: () => void };
      state.mode = 'success';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => {
        state.copied = text;
        if (state.mode === 'failure') return Promise.reject(new Error('denied'));
        if (state.mode === 'pending') return new Promise<void>(resolve => { state.finish = resolve; });
        return Promise.resolve();
      } } });
    });
    await page.goto(`${origin}/setup`);
    const client = page.locator('#setup-client');
    const language = page.getByRole('combobox', { name: '语言 / Language' });
    const login = page.locator('#cli .setup-step').nth(1);
    for (const locale of ['zh-CN', 'en']) {
      await language.selectOption(locale);
      for (const width of [320, 361, 362, 363, 375, 390, 768, 1360]) {
        await page.setViewportSize({ width, height: 900 });
        const stepWidth = await login.evaluate(element => element.getBoundingClientRect().width);
        if (width >= 361 && width <= 363) expect(stepWidth).toBe(width - 38);
        const narrow = stepWidth <= 324;
        const geometry = await login.evaluate(element => {
          const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
          const number = box('.setup-step-number'), title = box('h3'), content = box('.setup-step-content');
          const command = box('.setup-command'), code = box('pre'), button = box('button');
          return { number: { left: number.left, top: number.top }, title: { top: title.top }, content: { left: content.left }, command: { height: command.height }, code: { top: code.top, right: code.right, width: code.width }, button: { top: button.top, left: button.left, width: button.width, height: button.height } };
        });
        if (narrow) {
          expect(Math.abs(geometry.number.top - geometry.title.top)).toBeLessThanOrEqual(4);
          expect(geometry.content.left).toBeCloseTo(geometry.number.left, 0);
          expect(geometry.button).toMatchObject({ width: 32, height: 32 });
          expect(geometry.button.top).toBeCloseTo(geometry.code.top, 0);
          expect(geometry.button.left - geometry.code.right).toBeCloseTo(8, 0);
          if (width === 320) expect(geometry.command.height).toBeLessThanOrEqual(58);
        } else {
          expect(geometry.content.left).toBeGreaterThan(geometry.number.left);
          expect(geometry.button.width).toBe(26);
        }
        expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(width);
        for (const value of ['codex', 'claude', 'copilot']) {
          await client.selectOption(value);
          if (width === 320) {
            const configured = page.locator('#mcp .setup-command').nth(1);
            const displayed = await configured.locator('code').textContent();
            await configured.getByRole('button').click();
            await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(displayed);
            await expect(page.getByRole('status')).toBeVisible();
            await expect(client).toHaveValue(value);
          }
          if (narrow) {
            for (const command of await page.locator('.setup-command').all()) {
              const dimensions = await command.evaluate(element => {
                const code = element.querySelector('pre')!.getBoundingClientRect(), button = element.querySelector('button')!.getBoundingClientRect();
                return { codeWidth: code.width, gap: button.left - code.right, top: button.top - code.top, buttonWidth: button.width };
              });
              expect(dimensions.codeWidth).toBeGreaterThan(0);
              expect(dimensions.gap).toBeCloseTo(8, 0);
              expect(dimensions.top).toBeCloseTo(0, 0);
              expect(dimensions.buttonWidth).toBe(32);
            }
          }
        }
      }
    }
    await page.setViewportSize({ width: 320, height: 640 });
    const mcpButtons = page.locator('#mcp .setup-command button');
    await mcpButtons.first().focus();
    await page.keyboard.press('Tab');
    await expect(mcpButtons.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(await page.locator('#mcp .setup-command code').nth(1).textContent());
    const multiline = page.locator('#cli .setup-command').first();
    await multiline.getByRole('button').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(await multiline.locator('code').textContent());
    const command = login.locator('.setup-command');
    const button = command.getByRole('button');
    const text = await command.locator('code').textContent();
    await button.scrollIntoViewIfNeeded();
    const before = await login.boundingBox();
    await button.tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(text);
    await expect(page.getByRole('status')).toContainText('Copied.');
    expect(await login.boundingBox()).toEqual(before);
    await page.evaluate(() => { (window as unknown as { mode: string }).mode = 'pending'; });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toBeDisabled();
    await expect(client).toHaveValue('copilot');
    expect(await login.boundingBox()).toEqual(before);
    await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
    await expect(button).toBeEnabled();
    await page.evaluate(() => { (window as unknown as { mode: string }).mode = 'failure'; });
    await button.click();
    await expect(page.getByRole('status')).toContainText('could not copy');
    expect(await login.boundingBox()).toEqual(before);
    await expect(client).toHaveValue('copilot');
  });
});
