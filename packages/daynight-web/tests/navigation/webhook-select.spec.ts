import { expect, test, type Locator } from '@playwright/test';
import { id, install } from './webhook-select-fixture';
import { expectCopyButtonSkin } from './copy-button-assertions';

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 390, 320]) {
  test(`secret copy preserves reveal and shared control at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page, locale);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/webhooks?owner=personal');
    await page.getByRole('button', { name: 'Long receiver endpoint 0 for search and layout', exact: true }).click();
    const button = page.locator('.secret-actions').getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
    const secret = page.locator('#webhook-secret');
    await expectCopyButtonSkin(page, button);
    const copied: string[] = [];
    await page.exposeFunction('recordSecretCopy', (value: string) => copied.push(value));
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (value: string) => (window as unknown as { recordSecretCopy: (value: string) => Promise<void> }).recordSecretCopy(value) } }));
    await button.click();
    const value = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
    await expect(secret).toHaveText(value);
    expect(copied).toEqual([]);
    await button.focus(); await page.keyboard.press('Space');
    await expect.poll(() => copied).toEqual([value]);
    await expect(page.getByRole('status')).toContainText(locale === 'en' ? 'Copied' : '已复制');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(state.unexpected).toEqual([]);
  });
}

async function checkGeometry(control: Locator, height: number) {
  const geometry = await control.evaluate(element => {
    const select = element as HTMLSelectElement, wrapper = select.parentElement!, arrow = wrapper.querySelector('svg')!;
    const s = select.getBoundingClientRect(), a = arrow.getBoundingClientRect(), css = getComputedStyle(select);
    return { height: s.height, right: s.right - a.right, center: s.y + s.height / 2 - a.y - a.height / 2,
      arrowWidth: a.width, arrowHeight: a.height, padding: parseFloat(css.paddingRight), appearance: css.appearance,
      overflow: document.documentElement.scrollWidth - innerWidth, icons: wrapper.querySelectorAll('svg').length };
  });
  expect(geometry.height).toBe(height);
  expect(Math.abs(geometry.right - 12)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.center)).toBeLessThanOrEqual(1);
  expect(geometry.arrowWidth).toBe(10); expect(geometry.arrowHeight).toBe(10);
  expect(geometry.padding).toBeGreaterThanOrEqual(30); expect(geometry.appearance).toBe('none');
  expect(geometry.icons).toBe(1); expect(geometry.overflow).toBeLessThanOrEqual(0);
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`subscription and delivery selectors preserve drafts at ${width}px in ${locale}`, async ({ page }, info) => {
    const state = await install(page, locale);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/webhooks?owner=personal');
    await page.getByRole('button', { name: 'Long receiver endpoint 0 for search and layout', exact: true }).click();
    await page.getByRole('tab', { name: locale === 'en' ? /^Subscriptions/ : /^订阅/ }).click();
    await page.getByRole('button', { name: locale === 'en' ? 'Edit subscription Project one' : '编辑订阅 Project one' }).click();
    const dialog = page.getByRole('dialog');
    const project = dialog.getByRole('combobox', { name: locale === 'en' ? 'Project' : '项目' });
    await expect(project).toBeVisible(); await expect(project).toHaveValue(id(3));
    await expect(project.locator('option', { hasText: id(3) })).toHaveCount(1);
    await checkGeometry(project, 38);
    // The selection popup is native: clicking the decorative arrow opens it, and Escape only cancels it.
    const arrow = await project.locator('..').locator('svg').boundingBox();
    expect(arrow).not.toBeNull();
    await page.mouse.click(arrow!.x + arrow!.width / 2, arrow!.y + arrow!.height / 2);
    await expect.poll(() => project.evaluate(element => element.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => project.evaluate(element => element.matches(':open'))).toBe(false);
    await expect(dialog).toBeVisible(); await expect(project).toHaveValue(id(3));
    await project.selectOption(id(4));
    await project.evaluate(element => element.setAttribute('data-continuity', 'original'));
    const requestCount = state.requests.length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.requests.length).toBeGreaterThan(requestCount);
    await expect(project).toHaveAttribute('data-continuity', 'original'); await expect(project).toHaveValue(id(4));
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: info.outputPath(`subscription-${locale}-${width}.png`) });
    await dialog.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('tab', { name: locale === 'en' ? 'Deliveries' : '投递记录', exact: true }).click();
    await page.getByRole('button', { name: locale === 'en' ? 'Filter history' : '筛选历史' }).click();
    const event = page.getByRole('combobox', { name: locale === 'en' ? 'Event type' : '事件类型' });
    const status = page.getByRole('combobox', { name: locale === 'en' ? 'Delivery state' : '投递状态' });
    await checkGeometry(event, 38); await checkGeometry(status, 38);
    await expect.poll(() => state.deliveryQueries.length).toBeGreaterThan(0);
    const before = state.deliveryQueries.length;
    await event.selectOption('task.created'); await status.selectOption('failed');
    expect(state.deliveryQueries.length).toBe(before);
    await status.focus(); await status.evaluate(element => element.setAttribute('data-continuity', 'original'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.deliveryQueries.length).toBeGreaterThan(before);
    await expect(status).toHaveAttribute('data-continuity', 'original'); await expect(status).toBeFocused();
    await expect(status).toHaveValue('failed'); await expect(event).toHaveValue('task.created');
    const previous = new URLSearchParams(state.deliveryQueries.at(-1));
    expect(previous.has('eventType')).toBe(false); expect(previous.has('state')).toBe(false);
    await page.getByRole('button', { name: locale === 'en' ? 'Apply filters' : '应用筛选' }).click();
    await expect.poll(() => {
      const query = new URLSearchParams(state.deliveryQueries.at(-1));
      return [query.get('eventType'), query.get('state')];
    }).toEqual(['task.created', 'failed']);
    await page.screenshot({ path: info.outputPath(`delivery-${locale}-${width}.png`) });
    expect(state.unexpected).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`detail tabs remain reachable with a larger browser font in ${locale}`, async ({ page }) => {
    await install(page, locale);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto('/webhooks?owner=personal');
    await page.addStyleTag({ content: 'html { font-size: 32px; }' });
    await page.getByRole('button', { name: 'Long receiver endpoint 0 for search and layout', exact: true }).click();
    const tab = page.getByRole('tab', { name: locale === 'en' ? 'Deliveries' : '投递记录', exact: true });
    await tab.scrollIntoViewIfNeeded();
    await expect(tab).toBeVisible();
    const visible = await tab.evaluate(element => {
      const tab = element.getBoundingClientRect();
      const panel = element.closest('.detail-panel')!.getBoundingClientRect();
      return tab.left >= panel.left && tab.right <= panel.right && tab.top >= panel.top && tab.bottom <= panel.bottom;
    });
    expect(visible).toBe(true);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await tab.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  });
}
