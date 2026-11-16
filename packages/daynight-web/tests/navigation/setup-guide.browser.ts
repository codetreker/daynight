import { expect, test } from '@playwright/test';

const origin = `https://${'a'.repeat(55)}.${'b'.repeat(55)}.example.test:4443`;

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
  await page.locator('a[href="#mcp"]').click();
  await expect(page).toHaveURL(/#mcp$/);
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  for (const locale of ['zh-CN', 'en']) {
    await language.selectOption(locale);
    for (const value of ['codex', 'claude', 'copilot']) {
      await client.selectOption(value);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          controls: [...document.querySelectorAll('.setup-guide a, .setup-guide button, .setup-guide select')].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({ left: rect.left, right: rect.right })),
        }));
        expect(geometry.width, `${locale}/${value}/${width}`).toBeLessThanOrEqual(width);
        for (const bounds of geometry.controls) { expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); }
        for (const [control, height, fontSize] of [[client, 38, '12px'], [language, 32, '11px']] as const) {
          const skin = await control.evaluate(element => {
            const wrapper = element.closest('.native-select')!;
            const arrow = wrapper.querySelector('.native-select__arrow')!;
            const box = element.getBoundingClientRect(), arrowBox = arrow.getBoundingClientRect();
            const style = getComputedStyle(element);
            return { height: box.height, fontSize: style.fontSize, appearance: style.appearance, paddingEnd: parseFloat(style.paddingInlineEnd), arrowWidth: arrowBox.width, arrowHeight: arrowBox.height, endGap: box.right - arrowBox.right, centerOffset: Math.abs(box.top + box.height / 2 - arrowBox.top - arrowBox.height / 2), pointerEvents: getComputedStyle(arrow).pointerEvents };
          });
          expect(skin).toMatchObject({ height, fontSize, appearance: 'none', arrowWidth: 10, arrowHeight: 10, pointerEvents: 'none' });
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
