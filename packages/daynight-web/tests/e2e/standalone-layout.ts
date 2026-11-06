import { expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

export const verifyStandaloneLayout = async (page: Page, info: TestInfo): Promise<void> => {
  const measurements = [];
  const rows = page.locator('.standalone-row');
  const language = page.locator('.topbar').getByRole('combobox', { name: '语言 / Language', exact: true });
  for (const locale of ['zh-CN', 'en']) {
    await language.selectOption(locale);
    await expect(rows.locator('.task-paused-badge')).toHaveCount(1);
    await expect(rows.locator('.graph-blocked-badge')).toHaveCount(1);
    for (const collapsed of [false, true]) {
      await page.setViewportSize({ width: 1100, height: 1000 });
      const toggle = page.locator('.sidebar-toggle');
      if ((await page.locator('.sidebar').boundingBox())!.width !== (collapsed ? 68 : 190)) await toggle.click();
      for (const width of [768, 820, 900, 1000, 1100, 1360, 700, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect(rows.first()).toBeVisible();
        const read = () => rows.evaluateAll(elements => elements.map(row => {
          const title = row.querySelector<HTMLElement>('.root-heading')!;
          const badges = row.querySelector<HTMLElement>('.task-row-status')!;
          const bounds = row.getBoundingClientRect();
          return {
            titleWidth: title.getBoundingClientRect().width, height: bounds.height,
            listWidth: row.closest('.standalone-list')!.getBoundingClientRect().width,
            direction: getComputedStyle(badges).flexDirection,
            chevron: getComputedStyle(row.querySelector('.standalone-chevron')!).display,
            metadataSize: getComputedStyle(row.querySelector('.root-meta')!).fontSize,
            badges: [...badges.children].map(badge => ({ text: badge.textContent, width: badge.getBoundingClientRect().width,
              inside: badge.getBoundingClientRect().left >= bounds.left && badge.getBoundingClientRect().right <= bounds.right,
              unclipped: badge.scrollWidth <= badge.clientWidth + 1 })),
          };
        }));
        await expect.poll(async () => (await read()).every(row => row.direction === (row.listWidth <= 650 ? 'column' : 'row'))).toBe(true);
        const geometry = await read();
        for (const row of geometry) {
          // Allow half a CSS pixel for the approximately 200px title requirement.
          if (width >= 768 && width <= 1000) expect(row.titleWidth, `${locale} ${width}px collapsed=${collapsed}`).toBeGreaterThanOrEqual(199.5);
          if (width >= 1100) expect(row.direction).toBe('row');
          if (width <= 390) {
            expect(row.direction).toBe('column');
            expect(row.chevron).toBe('none');
            expect(row.metadataSize).toBe('9px');
          }
          expect(row.badges.every(badge => badge.inside && badge.unclipped && badge.width > 0)).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await rows.first().focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(rows.first()).toBeFocused();
        expect(await rows.first().evaluate(row => row.matches(':focus-visible') && getComputedStyle(row).outlineStyle !== 'none'
          && Number.parseFloat(getComputedStyle(row).outlineOffset) < 0)).toBe(true);
        measurements.push({ locale, collapsed, width, rows: geometry });
        if ([768, 1000, 320].includes(width)) {
          const path = info.outputPath(`standalone-${locale}-${collapsed ? 'collapsed' : 'expanded'}-${width}.png`);
          await page.screenshot({ path, fullPage: true });
          await info.attach(`standalone-${locale}-${collapsed}-${width}`, { path, contentType: 'image/png' });
        }
      }
    }
    await page.setViewportSize({ width: 768, height: 1000 });
    await rows.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.task-detail-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rows.first()).toBeFocused();
    await rows.last().click({ position: { x: 8, y: 8 } });
    await expect(page.locator('.task-detail-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  const geometryPath = info.outputPath('standalone-layout-geometry.json');
  await writeFile(geometryPath, JSON.stringify(measurements, null, 2));
  await info.attach('standalone-layout-geometry', { path: geometryPath, contentType: 'application/json' });
  await language.selectOption('zh-CN');
  await page.setViewportSize({ width: 1100, height: 1000 });
  if ((await page.locator('.sidebar').boundingBox())!.width === 68) await page.locator('.sidebar-toggle').click();
};
