import { expect, test, type Page } from '@playwright/test';

const labels = {
  en: { title: 'Browser logins', current: 'Current browser', end: 'End session', confirm: 'End browser session?', cancel: 'Cancel', empty: 'No other browser logins.', done: 'Browser session ended.' },
  'zh-CN': { title: '浏览器登录', current: '当前浏览器', end: '结束会话', confirm: '结束浏览器会话？', cancel: '取消', empty: '没有其他浏览器登录。', done: '浏览器会话已结束。' },
} as const;
const fits = async (page: Page) => {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), controls: [...document.querySelectorAll('button, summary')].filter(el => el.getClientRects().length > 0).map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, text: el.textContent }; }) }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  for (const control of dimensions.controls) { expect(control.left, control.text ?? '').toBeGreaterThanOrEqual(-1); expect(control.right, control.text ?? '').toBeLessThanOrEqual(dimensions.width + 1); }
};
for (const locale of ['en', 'zh-CN'] as const) {
  const m = labels[locale];
  test(`${locale}: 320px keyboard cancellation and confirmed session ending`, async ({ page }) => {
    await page.goto(`/tests/navigation/browser-sessions.html?locale=${locale}`);
    const panel = page.getByRole('region', { name: m.title });
    await expect(panel.getByText(m.current)).toBeVisible();
    const opener = panel.getByRole('button', { name: `${m.end}: Safari · iOS` });
    await expect(opener).toBeEnabled(); await fits(page);
    await opener.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: m.confirm });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: m.cancel })).toBeFocused(); await fits(page);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    expect(await page.evaluate(() => sessionStorage.getItem('fixture.write'))).toBeNull();
    await page.keyboard.press('Enter'); await dialog.getByRole('button', { name: m.end, exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(panel.getByText(m.done)).toBeVisible(); await expect(panel.getByText(m.empty)).toBeVisible();
    await expect(panel.getByRole('heading', { name: m.title })).toBeFocused(); await fits(page);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture.write') ?? 'null'))).toEqual({ id: '00000000-0000-4000-8000-000000000203', expectedUserId: '00000000-0000-4000-8000-000000000201', expectedSessionId: '00000000-0000-4000-8000-000000000202' });
  });
}
