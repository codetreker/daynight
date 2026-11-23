import { expect, type Locator } from '@playwright/test';

const colors = [
  ['Gray', '灰色', '#9AA3B2'],
  ['Red', '红色', '#D85656'],
  ['Orange', '橙色', '#D47A3D'],
  ['Yellow', '黄色', '#C8A12E'],
  ['Green', '绿色', '#62A273'],
  ['Teal', '青色', '#3A9D98'],
  ['Blue', '蓝色', '#4C88C7'],
  ['Purple', '紫色', '#6B65D8'],
  ['Pink', '粉色', '#C3659A'],
  ['Charcoal', '炭灰色', '#424B57'],
  ['Slate', '石板灰', '#647995'],
  ['Silver', '银灰色', '#BCC6D4'],
  ['Brick', '砖红色', '#A43E36'],
  ['Burgundy', '酒红色', '#7C2948'],
  ['Coral', '珊瑚色', '#F08374'],
  ['Peach', '蜜桃色', '#F3B698'],
  ['Amber', '琥珀色', '#E89117'],
  ['Lemon', '柠檬黄', '#F1D960'],
  ['Ochre', '赭黄色', '#987021'],
  ['Olive', '橄榄色', '#788537'],
  ['Lime', '青柠色', '#9CCB4B'],
  ['Forest', '森林绿', '#2F6E44'],
  ['Mint', '薄荷绿', '#9AD8B9'],
  ['Emerald', '祖母绿', '#238568'],
  ['Turquoise', '松石色', '#53C4C1'],
  ['Cyan', '湖蓝色', '#278EAC'],
  ['Sky', '天蓝色', '#91C5EE'],
  ['Navy', '藏蓝色', '#294B82'],
  ['Indigo', '靛蓝色', '#424AAB'],
  ['Lavender', '薰衣草色', '#B5A4E8'],
  ['Plum', '梅紫色', '#864C94'],
  ['Magenta', '洋红色', '#AF377D'],
] as const;

export async function expectTagPalette(container: Locator, locale: 'en' | 'zh-CN', width: number) {
  const presets = container.locator('.tag-color-presets');
  const buttons = presets.getByRole('button');
  await expect(buttons).toHaveCount(32);
  expect(await buttons.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(
    colors.map(([en, zh, hex]) => `${locale === 'en' ? en : zh} ${hex}`),
  );
  expect(new Set(colors.map(([, , hex]) => hex)).size).toBe(32);
  if (width === 320) {
    const layout = await presets.evaluate(element => ({
      fits: element.scrollWidth <= element.clientWidth,
      rows: new Set(Array.from(element.querySelectorAll('button'), button => button.getBoundingClientRect().top)).size,
    }));
    expect(layout.fits).toBe(true);
    expect(layout.rows).toBeGreaterThan(1);
  }
}
