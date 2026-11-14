import { expect, test, type Page } from '@playwright/test';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userId = id(1), teamId = id(2), now = '2026-11-08T00:00:00Z';
const user = { id: userId, name: 'Alice', email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: id(10), kind: 'personal', name: null } };
const catalog = {
  items: ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted'].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: 'project' })),
  service: { configurationExpansionAvailable: true, dispatchEnabled: false },
  limits: { policyVersion: '1', requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 },
};

async function install(page: Page, locale: 'en' | 'zh-CN') {
  const requests: { owner: string; query: string; enabled: string | null; cursor: string | null }[] = [];
  const unexpected: string[] = [];
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let body: unknown;
    if (path === '/api/v1/me') body = user;
    else if (path === '/api/v1/auth/providers') body = { providers: ['github'] };
    else if (path === '/api/v1/webhook-event-types') body = catalog;
    else if (path === '/api/v1/teams') body = { items: [{ id: teamId, kind: 'ordinary', name: 'A very long engineering team name used to exercise the selector', version: 1, createdAt: now, updatedAt: now, membership: { teamId, userId, role: 'admin', version: 1, createdAt: now, updatedAt: now } }], nextCursor: null };
    else if (path === '/api/v1/projects') body = { items: [], nextCursor: null };
    else if (path === '/api/v1/me/webhooks' || path === `/api/v1/teams/${teamId}/webhooks`) {
      const owner = path.includes('/teams/') ? 'team' : 'personal';
      const q = url.searchParams.get('q') ?? '', enabled = url.searchParams.get('enabled'), cursor = url.searchParams.get('cursor');
      requests.push({ owner, query: q, enabled, cursor });
      const values = [true, false, true].map((active, i) => ({ id: id(i + 20), owner: { kind: owner, id: owner === 'team' ? teamId : userId }, name: `Long receiver endpoint ${i} for search and layout`, enabled: active, configVersion: '1', destination: { kind: 'http', adapterVersion: '1', url: null, displayUrl: `https://receiver.example/very/long/path/${i}` }, projectCount: 1, eventTypeCount: 1, lastAttemptAt: null, lastResult: null }))
        .filter(item => (q === '' || item.name.includes(q) || item.destination.displayUrl.includes(q)) && (enabled === null || String(item.enabled) === enabled));
      const start = Number(cursor ?? 0);
      body = { items: values.slice(start, start + 2), nextCursor: start + 2 < values.length ? String(start + 2) : null };
    } else if (/^\/api\/v1\/(?:me|teams\/[^/]+)\/webhooks\/[^/]+$/.test(path)) {
      const owner = path.includes('/teams/') ? { kind: 'team', id: teamId } : { kind: 'personal', id: userId };
      body = { id: path.split('/').at(-1), owner, lifecycle: 'active', configVersion: '1', deletedAt: null, name: 'Long receiver endpoint 0 for search and layout', enabled: true, destinationRevision: '1', destination: { kind: 'http', adapterVersion: '1', url: 'https://receiver.example/very/long/path/0', displayUrl: 'https://receiver.example/very/long/path/0' }, signing: { scheme: 'standard-webhooks-v1', activeKeyId: id(6), overlapUntil: null }, subscriptions: [{ id: id(7), projectId: id(3), projectName: 'Project one', eventTypes: ['task.created'], eligibility: 'eligible' }], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now };
    } else { unexpected.push(`${request.method()} ${path}`); body = {}; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Daynight-User-ID': userId }, body: JSON.stringify(body) });
  });
  return { requests, unexpected };
}

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
      expect(Math.abs(g.select.right - g.arrow.right - 9)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.select.y + g.select.height / 2 - g.arrow.y - g.arrow.height / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.select.y - g.search.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.select.height - g.search.height)).toBeLessThanOrEqual(1);
      expect(g.select.x + 1 + g.paddingLeft + g.textWidth).toBeLessThanOrEqual(g.select.right - 1 - g.paddingRight + 1);
      expect(g.select.x + 1 + g.paddingLeft + g.textWidth).toBeLessThanOrEqual(g.arrow.x);
      expect(g.paddingRight).toBeGreaterThanOrEqual(29);
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
    expect(await team.evaluate(element => getComputedStyle(element).appearance)).toBe('auto');
    await filter.selectOption('paused'); await expect.poll(() => state.requests.at(-1)?.enabled).toBe('false');
    await page.getByRole('button', { name: locale === 'en' ? 'Personal' : '个人专属', exact: true }).click();
    await expect(filter).toHaveValue('all');
    await page.getByRole('button', { name: locale === 'en' ? 'Team shared' : '团队共享', exact: true }).click();
    await team.selectOption(teamId); await expect(filter).toHaveValue('paused');
    expect(state.unexpected).toEqual([]);

    // Reconstruct the original bare select on the production page for before/after evidence.
    await page.getByRole('button', { name: locale === 'en' ? 'Personal' : '个人专属', exact: true }).click();
    await expect(filter).toHaveValue('all');
    const before = await filter.evaluate(element => {
      const wrapper = element.parentElement!; wrapper.replaceWith(element);
      const select = element.getBoundingClientRect(), search = element.parentElement!.querySelector('input')!.getBoundingClientRect();
      return { select: { x: select.x, y: select.y, width: select.width, height: select.height }, search: { y: search.y, height: search.height }, appearance: getComputedStyle(element).appearance, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    await page.screenshot({ path: info.outputPath(`webhook-before-${locale}-${width}.png`) });
    await info.attach(`webhook-before-geometry-${locale}-${width}`, { body: JSON.stringify(before), contentType: 'application/json' });
  });
}
