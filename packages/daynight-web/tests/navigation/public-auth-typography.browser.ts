import { expect, test, type Page } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000201';
const requestId = '00000000-0000-4000-8000-000000000202';
const code = 'BCDFG-HJKLM';
const user = {
  id: userId, personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal', name: null },
  name: '长名称 LongAccountNameWithoutSpaces'.repeat(5), email: `${'long'.repeat(22)}@example.test`, emailVerified: true, avatarUrl: null,
};
const consent = {
  requestId, userId, status: 'pending', clientName: '长客户端名称 LongClientNameWithoutSpaces'.repeat(6),
  clientId: 'typography-client', clientProvenance: 'dcr', redirectUri: `http://127.0.0.1:41235/${'callback'.repeat(20)}?source=typography`,
  resource: 'http://127.0.0.1:4211/mcp', scope: 'daynight:mcp', codeExpired: false,
};
const error = { error: { code: 'internal_error', message: 'unavailable', requestId: 'typography-fixture' } };

const expectFits = async (page: Page) => {
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth, document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    controls: [...document.querySelectorAll('main button, main a, main input, .auth-card button, .setup-guide select')]
      .filter(element => element.getClientRects().length > 0).map(element => {
        const rect = element.getBoundingClientRect(); return { text: element.textContent?.slice(0, 60), left: rect.left, right: rect.right };
      }),
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
  for (const rect of geometry.controls) {
    expect(rect.left, rect.text).toBeGreaterThanOrEqual(-1);
    expect(rect.right, rect.text).toBeLessThanOrEqual(geometry.viewport + 1);
  }
};

const expectRole = async (page: Page, selector: string, role: string) => {
  const text = page.locator(selector).first();
  await expect(text).toBeVisible();
  const sizes = await text.evaluate((element, variable) => {
    const probe = document.createElement('span'); probe.style.fontSize = `var(${variable})`; document.body.append(probe);
    const actual = getComputedStyle(element).fontSize, expected = getComputedStyle(probe).fontSize;
    probe.remove(); return { actual, expected };
  }, role);
  expect(sizes.actual, selector).toBe(sizes.expected);
};

for (const locale of ['en', 'zh-CN']) {
  test(`public pages retain semantic text and actions at narrow and enlarged sizes (${locale})`, async ({ page }, testInfo) => {
    await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), locale);
    await page.route('**/api/v1/me', route => route.fulfill({ status: 401, json: error }));
    await page.goto('/');
    await expect(page.locator('.landing-page h1')).toBeVisible();
    for (const rootSize of ['16px', '20px']) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, rootSize);
      for (const width of [1440, 720, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expectRole(page, '.landing-page h1', '--text-page-heading');
        await expectRole(page, '.hero-copy', '--text-reading');
        await expectRole(page, '.scene-tab', '--text-interface');
        await expectFits(page);
        for (const tab of await page.locator('.scene-tab').all()) { await tab.click(); await expectFits(page); }
        for (const summary of await page.locator('.faq-list summary').all()) { await summary.click(); await expectFits(page); }
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`${locale}-landing-320.png`), fullPage: true });
    await page.goto('/setup');
    await expect(page.locator('.setup-guide')).toBeVisible();
    for (const rootSize of ['16px', '20px']) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, rootSize);
      for (const width of [1440, 720, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expectRole(page, '.setup-command code', '--text-interface');
        await expectFits(page);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`${locale}-setup-320-enlarged.png`), fullPage: true });
  });

  test(`standalone login and authorization preserve form access (${locale})`, async ({ page }, testInfo) => {
    await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), locale);
    let signedIn = false;
    let providerState: 'error' | 'ready' = 'error';
    await page.route('**/api/v1/me', route => route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? user : error }));
    const providers = Promise.withResolvers<void>();
    await page.route('**/api/v1/auth/providers', async route => { await providers.promise; return route.fulfill({ status: providerState === 'error' ? 503 : 200, json: providerState === 'error' ? error : { providers: ['microsoft', 'google', 'github'] } }); });
    await page.goto('/login');
    await expect(page.locator('.auth-card [role="status"]')).toBeVisible();
    await expectFits(page);
    providers.resolve();
    await expect(page.locator('.auth-card [role="alert"]')).toBeVisible();
    await expectRole(page, '.auth-card [role="alert"] p', '--text-interface');
    providerState = 'ready';
    await page.locator('.auth-card [role="alert"] button').click();
    await expect(page.locator('.provider-button')).toHaveCount(3);
    for (const rootSize of ['16px', '20px']) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, rootSize);
      for (const width of [1440, 720, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expectRole(page, '.auth-card h1', '--text-page-heading');
        await expectRole(page, '.provider-button', '--text-interface');
        await expectFits(page);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`${locale}-login-320-enlarged.png`), fullPage: true });
    signedIn = true;
    await page.route('**/api/v1/auth/device/inspect', route => route.fulfill({ json: { userCode: code, status: 'pending', expiresAt: new Date(Date.now() + 600_000).toISOString() }, headers: { 'Daynight-User-ID': userId } }));
    await page.goto('/device');
    await expect(page.locator('#device-user-code')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 900 });
    await expectRole(page, '#device-user-code', '--text-section-heading');
    await page.locator('#device-user-code').fill(code);
    await page.locator('.device-code-form button').click();
    await expect(page.locator('.device-code code')).toHaveText(code);
    await expect(page.locator('.device-actions .primary')).toBeDisabled();
    await page.locator('.device-match input').check();
    await expect(page.locator('.device-actions .primary')).toBeEnabled();
    for (const rootSize of ['16px', '20px']) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, rootSize);
      for (const width of [1440, 720, 320]) { await page.setViewportSize({ width, height: 900 }); await expectFits(page); }
    }
    await page.screenshot({ path: testInfo.outputPath(`${locale}-device-320.png`), fullPage: true });
    const request = Promise.withResolvers<void>();
    await page.route(`**/api/v1/oauth/requests/${requestId}`, async route => { await request.promise; return route.fulfill({ json: consent }); });
    await page.goto(`/oauth/consent?request=${requestId}`);
    await expect(page.locator('.device-loading')).toBeVisible();
    await expectFits(page);
    request.resolve();
    await expect(page.locator('.client-name')).toHaveText(consent.clientName);
    await page.locator('.callback-box summary').click();
    for (const rootSize of ['16px', '20px']) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, rootSize);
      for (const width of [1440, 720, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expectRole(page, '.consent-card h1', '--text-page-heading');
        await expectRole(page, '.device-actions .primary', '--text-interface');
        await expectFits(page);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`${locale}-consent-320-enlarged.png`), fullPage: true });
    await page.setViewportSize({ width: 720, height: 450 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(2);
    await page.locator('.device-actions .primary').scrollIntoViewIfNeeded();
    await expect(page.locator('.device-actions .primary')).toBeVisible();
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await cdp.detach();
  });
}
