import { expect, test } from '@playwright/test';
import { install, teamId } from './webhook-select-fixture';

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 800, 450, 390, 320]) {
  test(`status filter geometry and native interaction at ${width}px in ${locale}`, async ({ page }, info) => {
    const state = await install(page, locale);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/webhooks?owner=personal');
    const label = locale === 'en' ? 'All statuses' : '全部状态';
    const filter = page.getByRole('combobox', { name: label });
    const search = page.getByRole('searchbox', { name: locale === 'en' ? 'Search name or URL' : '搜索名称或 URL' });
    const arrow = page.locator('.webhook-status-select svg');
    await expect(filter).toBeVisible(); await expect(page.locator('.endpoint-row')).toHaveCount(2);
    await expect(filter.locator('option')).toHaveText(locale === 'en' ? ['All statuses', 'Enabled', 'Paused'] : ['全部状态', '已启用', '已暂停']);
    await expect(arrow).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('button', { name: locale === 'en' ? 'Load more' : '加载更多', exact: true }).click();
    await expect(page.locator('.endpoint-row')).toHaveCount(3);
    expect(state.requests.some(request => request.cursor === '2')).toBe(true);
    await search.focus(); await page.keyboard.press('Tab'); await expect(filter).toBeFocused();
    const geometry = async () => await filter.evaluate(element => {
      const select = element as HTMLSelectElement, wrapper = select.parentElement!, icon = wrapper.querySelector('svg')!, searchBox = wrapper.parentElement!.querySelector('input')!;
      const s = select.getBoundingClientRect(), a = icon.getBoundingClientRect(), b = searchBox.getBoundingClientRect(), css = getComputedStyle(select);
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
      context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      return { select: { x: s.x, y: s.y, width: s.width, height: s.height, right: s.right }, arrow: { x: a.x, y: a.y, width: a.width, height: a.height, right: a.right }, search: { y: b.y, height: b.height }, textWidth: context.measureText(select.selectedOptions[0]!.textContent ?? '').width, paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight), appearance: css.appearance, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    for (const value of ['all', 'enabled', 'paused']) {
      await filter.selectOption(value);
      const g = await geometry();
      expect(g.appearance).toBe('none');
      expect(Math.abs(g.arrow.width - 10)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.arrow.height - 10)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.select.right - g.arrow.right - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.select.y + g.select.height / 2 - g.arrow.y - g.arrow.height / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.select.y - g.search.y)).toBeLessThanOrEqual(1);
      expect(g.select.height).toBe(32);
      expect(g.select.right - g.paddingRight).toBeLessThanOrEqual(g.arrow.x - 8);
      expect(g.paddingRight).toBeGreaterThanOrEqual(30);
      expect(g.overflow).toBeLessThanOrEqual(0);
    }
    await filter.selectOption('all');
    await page.screenshot({ path: info.outputPath(`webhook-after-${locale}-${width}.png`) });
    const after = await geometry();
    await info.attach(`webhook-after-geometry-${locale}-${width}`, { body: JSON.stringify(after), contentType: 'application/json' });

    // Clicking the decorative icon must target the native control, which remains keyboard operable.
    const iconBox = (await arrow.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: iconBox.x + iconBox.width / 2, y: iconBox.y + iconBox.height / 2 })).toBe('SELECT');
    await page.mouse.click(iconBox.x + iconBox.width / 2, iconBox.y + iconBox.height / 2); await expect(filter).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(filter).toHaveValue('enabled');
    await expect.poll(() => state.requests.at(-1)?.enabled).toBe('true');
    await filter.selectOption('paused'); await expect.poll(() => state.requests.at(-1)?.enabled).toBe('false');
    await search.fill('endpoint 1');
    await expect.poll(() => state.requests.at(-1)?.query).toBe('endpoint 1');
    expect(state.requests.at(-1)?.enabled).toBe('false');
    await filter.selectOption('all'); await expect.poll(() => state.requests.at(-1)?.enabled).toBe(null);
    expect(state.requests.at(-1)?.query).toBe('endpoint 1');
    await search.fill(''); await expect.poll(() => state.requests.at(-1)?.query).toBe('');
    await page.getByRole('button', { name: locale === 'en' ? 'Team shared' : '团队共享' }).click();
    const team = page.getByRole('combobox', { name: locale === 'en' ? 'Choose a team' : '选择团队' });
    await expect(team.locator('option')).toHaveCount(2); await team.selectOption(teamId);
    await expect.poll(() => state.requests.at(-1)?.owner).toBe('team');
    expect(await team.evaluate(element => getComputedStyle(element).appearance)).toBe('none');
    await filter.selectOption('paused'); await expect.poll(() => state.requests.at(-1)?.enabled).toBe('false');
    await page.getByRole('button', { name: locale === 'en' ? 'Personal' : '个人专属', exact: true }).click();
    await expect(filter).toHaveValue('all');
    await page.getByRole('button', { name: locale === 'en' ? 'Team shared' : '团队共享', exact: true }).click();
    await team.selectOption(teamId); await expect(filter).toHaveValue('paused');
    expect(state.unexpected).toEqual([]);

  });
}
