import { expect, test, type Locator, type Page } from '@playwright/test';
import { id, install, now, teamId, userId } from './webhook-select-fixture';

test.use({ hasTouch: true });

const endpointId = id(20), keys = ['configuration', 'subscriptions', 'deliveries'] as const;
type Owner = 'personal' | 'team';
const address = (owner: Owner, tab: typeof keys[number] = 'configuration') => `/webhooks?owner=${owner}${owner === 'team' ? `&teamId=${teamId}` : ''}&endpointId=${endpointId}&tab=${tab}`;
const track = (page: Page) => page.getByRole('tablist', { name: 'Webhook', exact: true });
const tab = (page: Page, key: typeof keys[number]) => page.locator(`#webhook-tab-${key}`);

async function setup(page: Page, locale: 'en' | 'zh-CN', options: { count?: number; readOnly?: boolean; deleted?: boolean; missing?: boolean; failOnce?: boolean; disabled?: boolean } = {}) {
  const state = await install(page, locale), writes: string[] = [];
  let detailReads = 0, failDetail = options.failOnce === true;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/v1/') && request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`); });
  await page.route(/\/api\/v1\/teams\/[^/]+\/webhooks(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', headers: { 'Daynight-User-ID': userId }, body: JSON.stringify({ items: [{ id: endpointId, owner: { kind: 'team', id: teamId }, name: 'Long receiver endpoint 0 for search and layout', enabled: !options.disabled, configVersion: '1', destination: { kind: 'http', adapterVersion: '1', url: options.readOnly ? null : 'https://receiver.example/path', displayUrl: 'https://receiver.example/path' }, projectCount: 1, eventTypeCount: 1, lastAttemptAt: null, lastResult: null }], nextCursor: null }) }));
  await page.route(/\/api\/v1\/(?:me|teams\/[^/]+)\/webhooks\/[^/?]+(?:\?.*)?$/, async route => {
    detailReads++;
    const path = new URL(route.request().url()).pathname, owner = path.includes('/teams/') ? { kind: 'team', id: teamId } : { kind: 'personal', id: userId };
    const status = options.missing ? 404 : failDetail ? 503 : 200;
    const body = status !== 200 ? { error: { code: status === 404 ? 'not_found' : 'database_unavailable', message: 'Fixture endpoint read failed', requestId: 'tabs-fixture' } } : options.deleted ? { id: endpointId, owner, lifecycle: 'deleted', configVersion: '2', deletedAt: now } : {
      id: endpointId, owner, lifecycle: 'active', configVersion: '1', deletedAt: null,
      name: 'Long receiver endpoint 0 for search and layout', enabled: !options.disabled,
      destinationRevision: '1', destination: { kind: 'http', adapterVersion: '1', url: options.readOnly ? null : 'https://receiver.example/path', displayUrl: 'https://receiver.example/path' },
      signing: { scheme: 'standard-webhooks-v1', activeKeyId: id(6), overlapUntil: null },
      subscriptions: Array.from({ length: options.count ?? 1 }, (_, index) => ({ id: id(100 + index), projectId: id(1000 + index), projectName: `Project ${index}`, eventTypes: ['task.created'], eligibility: 'eligible' })),
      capabilities: { manage: !options.readOnly, readSecret: !options.readOnly, redeliver: !options.readOnly }, createdAt: now, updatedAt: now,
    };
    await route.fulfill({ status, contentType: 'application/json', headers: { 'Daynight-User-ID': userId }, body: JSON.stringify(body) });
  });
  return { ...state, writes, reads: () => detailReads, recover: () => { failDetail = false; } };
}

const geometry = (list: Locator) => list.evaluate(element => {
  const box = element.getBoundingClientRect(), css = getComputedStyle(element);
  return { width: box.width, height: box.height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollLeft: element.scrollLeft, padding: [css.paddingLeft, css.paddingRight], gap: css.columnGap,
    outerOverflow: document.documentElement.scrollWidth - innerWidth,
    tabs: Array.from(element.querySelectorAll<HTMLElement>('[role=tab]')).map(button => { const rect = button.getBoundingClientRect(); return { text: button.textContent, left: rect.left - box.left, right: rect.right - box.left, top: rect.top - box.top, height: rect.height, fontSize: getComputedStyle(button).fontSize }; }) };
});
async function selectedVisible(page: Page, key: typeof keys[number]) {
  await expect(tab(page, key)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => tab(page, key).evaluateAll(elements => {
    const element = elements[0], parent = element?.closest('[role=tablist]');
    if (parent === null || parent === undefined) return false;
    const rect = element!.getBoundingClientRect(), box = parent.getBoundingClientRect();
    return rect.left >= box.left - 1 && rect.right <= box.right + 1;
  })).toBe(true);
}

for (const owner of ['personal', 'team'] as const) for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 375, 390, 768, 1360]) {
  test(`endpoint tabs fit one row for ${owner} ${locale} ${width}px`, async ({ page }, info) => {
    const state = await setup(page, locale);
    await page.setViewportSize({ width, height: 900 }); await page.goto(address(owner));
    await expect(track(page).getByRole('tab')).toHaveCount(3);
    const value = await geometry(track(page));
    expect(new Set(value.tabs.map(item => item.top)).size).toBe(1);
    expect(value.height).toBeGreaterThanOrEqual(46); expect(value.height).toBeLessThan(51);
    for (const item of value.tabs) { expect(item.height).toBeGreaterThanOrEqual(44); expect(item.left).toBeGreaterThanOrEqual(0); expect(item.right).toBeLessThanOrEqual(value.width); expect(item.fontSize).toBe('14px'); }
    expect(value.outerOverflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath('endpoint-tabs.png') });
    await info.attach('geometry', { body: JSON.stringify(value), contentType: 'application/json' });
    await tab(page, 'subscriptions').tap(); await selectedVisible(page, 'subscriptions');
    await tab(page, 'deliveries').tap(); await selectedVisible(page, 'deliveries');
    expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`compact spacing follows the detail container boundary in ${locale}`, async ({ page }) => {
    await setup(page, locale); await page.setViewportSize({ width: 1360, height: 900 }); await page.goto(address('personal'));
    await expect(track(page)).toBeVisible();
    for (const width of [359, 360, 361]) {
      await page.locator('.detail-panel').evaluate((element, width) => { (element as HTMLElement).style.width = `${width + 2}px`; }, width);
      await expect.poll(async () => Math.round((await geometry(track(page))).width)).toBe(width);
      const value = await geometry(track(page));
      expect(value.padding).toEqual(width <= 360 ? ['8px', '8px'] : ['18px', '18px']);
      expect(value.gap).toBe(width <= 360 ? '4px' : '20px');
      expect(value.tabs.every(item => item.top === value.tabs[0]!.top)).toBe(true);
    }
  });
}

for (const owner of ['personal', 'team'] as const) for (const locale of ['en', 'zh-CN'] as const) {
  test(`overflow, keyboard and route reveal remain local for ${owner} ${locale}`, async ({ page }, info) => {
    const state = await setup(page, locale, { count: 120 });
    await page.setViewportSize({ width: 320, height: 900 }); await page.goto(address(owner, 'deliveries'));
    await expect(track(page)).toBeVisible();
    // Isolate tab-induced scrolling from browser anchoring during translated header reflow.
    await page.addStyleTag({ content: 'html { font-size: 32px; overflow-anchor: none; }' });
    await selectedVisible(page, 'deliveries');
    await track(page).scrollIntoViewIfNeeded();
    expect((await geometry(track(page))).scrollWidth).toBeGreaterThan((await geometry(track(page))).clientWidth);
    await expect(page.locator('.endpoint-tabs')).toHaveAttribute('data-overflow-start', 'true');
    await tab(page, 'deliveries').evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
    const outer = await page.evaluate(() => [scrollX, scrollY]);
    for (const [key, expected] of [['Home', 'configuration'], ['ArrowRight', 'subscriptions'], ['End', 'deliveries'], ['ArrowRight', 'configuration'], ['ArrowLeft', 'deliveries']] as const) {
      await page.keyboard.press(key); await selectedVisible(page, expected); await expect(tab(page, expected)).toBeFocused();
      expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(outer);
    }
    await page.locator('.topbar select').selectOption(locale === 'en' ? 'zh-CN' : 'en');
    await selectedVisible(page, 'deliveries');
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(outer);
    const list = track(page); await list.scrollIntoViewIfNeeded(); await list.evaluate(element => { element.scrollLeft = 0; });
    await expect(page.locator('.endpoint-tabs')).toHaveAttribute('data-overflow-end', 'true');
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(250, 0);
    await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('overflow.png') });
    await info.attach('overflow-geometry', { body: JSON.stringify(await geometry(list)), contentType: 'application/json' });
    expect((await geometry(list)).outerOverflow).toBeLessThanOrEqual(0); expect(state.writes).toEqual([]);
  });
}

for (const owner of ['personal', 'team'] as const) {
  test(`direct tab URLs, narrow return and browser back preserve ${owner} selection`, async ({ page }) => {
    const state = await setup(page, 'en'); await page.setViewportSize({ width: 320, height: 900 });
    for (const key of keys) { await page.goto(address(owner, key)); await selectedVisible(page, key); }
    await page.locator('.detail-back').click();
    await expect(page.locator('.list-panel')).toBeVisible(); await expect(page.locator('.detail-panel')).toBeHidden();
    await page.goBack(); await selectedVisible(page, 'deliveries');
    expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]);
  });
}

test('retry, paused configuration and readonly controls preserve endpoint tab navigation', async ({ page }) => {
  const state = await setup(page, 'en', { failOnce: true, readOnly: true, disabled: true });
  await page.setViewportSize({ width: 320, height: 900 }); await page.goto(address('team'));
  await expect(page.locator('.detail-panel').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  state.recover();
  await page.locator('.detail-panel').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(track(page).getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.detail-status')).toContainText('Paused');
  await expect(page.getByRole('switch')).toBeDisabled();
  await expect(page.locator('.detail-heading-top').getByRole('button')).toBeDisabled();
  await tab(page, 'subscriptions').tap(); await selectedVisible(page, 'subscriptions');
  await expect(page.getByRole('button', { name: 'Add subscription', exact: true })).toBeDisabled();
  await tab(page, 'deliveries').tap(); await selectedVisible(page, 'deliveries');
  expect(state.reads()).toBeGreaterThanOrEqual(2); expect(state.writes).toEqual([]);
});

for (const kind of ['deleted', 'missing'] as const) {
  test(`${kind} endpoint retains a single readonly delivery tab`, async ({ page }) => {
    const state = await setup(page, 'en', { [kind]: true }); await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(address('personal', 'deliveries'));
    await expect(track(page).getByRole('tab')).toHaveCount(1); await selectedVisible(page, 'deliveries');
    await expect(page.locator('.detail-back')).toBeVisible();
    expect((await geometry(track(page))).outerOverflow).toBeLessThanOrEqual(0);
    expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]);
  });
}
