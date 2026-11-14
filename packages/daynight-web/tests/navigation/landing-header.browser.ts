import { expect, test } from '@playwright/test';

for (const state of ['pending', 'anonymous', 'unavailable', 'authenticated'] as const) {
  test(`landing header fits and expresses ${state} identity on narrow screens`, async ({ page }) => {
    const gate = Promise.withResolvers<void>();
    await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
    await page.route('**/api/v1/me', async route => {
      if (state === 'pending') await gate.promise;
      if (state === 'anonymous' || state === 'pending') return route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'anonymous', requestId: 'fixture' } } });
      if (state === 'unavailable') return route.fulfill({ status: 503, json: { error: { code: 'internal_error', message: 'unavailable', requestId: 'fixture' } } });
      return route.fulfill({ status: 200, json: { id: '00000000-0000-4000-8000-000000000201', personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null } });
    });
    try {
      await page.goto('/');
      const header = page.locator('.site-header');
      await expect(header.locator('.brand')).toBeVisible(); await expect(header.locator('select')).toHaveValue('en');
      const expected = state === 'anonymous' ? 'Sign in' : state === 'authenticated' ? 'Open workspace' : 'Sign in / workspace';
      await expect(header.locator('.nav-start')).toContainText(expected);
      if (state === 'unavailable') await expect(header.locator('.identity-notice')).toBeVisible();
      const language = header.getByRole('combobox', { name: '语言 / Language' });
      for (const [locale, width] of ['en', 'zh-CN'].flatMap(locale => [320, 361, 375, 390].map(width => [locale, width] as const))) {
        await language.selectOption(locale);
        await page.setViewportSize({ width, height: 844 });
        const geometry = await header.evaluate(element => ({ width: innerWidth, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), controls: [...element.querySelectorAll('a,select')].map(control => control.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({ left: rect.left, right: rect.right })) }));
        expect(geometry.width).toBe(width); expect(geometry.documentWidth).toBeLessThanOrEqual(width); expect(geometry.controls.length).toBeGreaterThan(1);
        for (const bounds of geometry.controls) { expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); }
        const skin = await language.evaluate(element => {
          const wrapper = element.closest('.native-select')!;
          const arrow = wrapper.querySelector('.native-select__arrow')!;
          const box = element.getBoundingClientRect(), arrowBox = arrow.getBoundingClientRect();
          return { height: box.height, fontSize: getComputedStyle(element).fontSize, appearance: getComputedStyle(element).appearance, arrowWidth: arrowBox.width, arrowHeight: arrowBox.height, endGap: box.right - arrowBox.right, centerOffset: Math.abs(box.top + box.height / 2 - arrowBox.top - arrowBox.height / 2), localeDecoration: getComputedStyle(element.closest('.locale-control')!, '::after').content };
        });
        expect(skin).toMatchObject({ height: 32, fontSize: '11px', appearance: 'none', arrowWidth: 10, arrowHeight: 10, localeDecoration: 'none' });
        expect(Math.abs(skin.endGap - 12)).toBeLessThanOrEqual(1);
        expect(skin.centerOffset).toBeLessThanOrEqual(1);
      }
    } finally { gate.resolve(); }
  });
}
