import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const time = '2026-10-20T09:00:00Z';
const longName = 'LongTeamNameWithoutAnySpaces'.repeat(12);
const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : longName, version: 1, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });

const catalog = {
  items: ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted'].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: 'project' })),
  service: { configurationExpansionAvailable: true, dispatchEnabled: false },
  limits: { policyVersion: '1', requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 },
};

const install = async (page: Page, webhooksAvailable = true) => {
  let projectReads = 0;
  await page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/webhook-event-types' && webhooksAvailable) return send(catalog);
    if (path === '/api/v1/me') return send({ id: userId, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [team(teamId)], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}` || path === `/api/v1/teams/${personalId}`) return send(team(path.split('/').at(-1)!));
    if (path === '/api/v1/projects') {
      projectReads++;
      return send({ items: Array.from({ length: 28 }, (_, index) => ({ id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, name: `Project ${index} ${'long-project-name-without-spaces'.repeat(4)}`, repoUrl: 'https://github.com/example/project', createdAt: time, updatedAt: time, ownership: { teamId, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 } })), nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  return () => projectReads;
};


// Read geometry from the real, styled navigation. Elements outside the scrollport
// still participate in layout, so the complete column can be measured together.
const expectIconColumn = async (sidebar: Locator) => {
  const links = sidebar.locator('.sidebar-group > a.nav-button');
  await expect(links).toHaveCount(9);
  const icons = links.locator('.nav-icon');
  await expect(icons.locator('svg')).toHaveCount(9);
  const geometry = await links.evaluateAll(elements => elements.map(link => {
    const slot = link.querySelector<HTMLElement>('.nav-icon')!;
    const svg = slot.querySelector<SVGSVGElement>('svg')!;
    const slotBox = slot.getBoundingClientRect();
    const svgBox = svg.getBoundingClientRect();
    const rowBox = link.getBoundingClientRect();
    const iconStyle = getComputedStyle(svg);
    const drawing = svg.getBBox();
    const text = link.querySelector<HTMLElement>('.nav-text')!;
    return {
      slot: [slotBox.width, slotBox.height], svg: [svgBox.width, svgBox.height],
      x: slotBox.x + slotBox.width / 2,
      slotY: slotBox.y + slotBox.height / 2, svgY: svgBox.y + svgBox.height / 2,
      rowY: rowBox.y + rowBox.height / 2,
      svgX: svgBox.x + svgBox.width / 2,
      iconColor: iconStyle.color, textColor: getComputedStyle(text).color,
      drawing: [drawing.x, drawing.y, drawing.x + drawing.width, drawing.y + drawing.height],
      viewBox: svg.getAttribute('viewBox'), stroke: iconStyle.stroke,
      strokeWidth: iconStyle.strokeWidth, fill: iconStyle.fill,
      hidden: slot.getAttribute('aria-hidden') === 'true' || svg.getAttribute('aria-hidden') === 'true',
      focusable: svg.getAttribute('focusable'), tabIndex: svg.getAttribute('tabindex'),
      label: link.getAttribute('aria-label'), title: link.getAttribute('title'),
    };
  }));
  for (const icon of geometry) {
    expect(icon.slot).toEqual([18, 18]);
    expect(icon.svg).toEqual([18, 18]);
    expect(icon.x).toBeCloseTo(geometry[0]!.x, 1);
    expect(icon.svgX).toBeCloseTo(icon.x, 1);
    expect(icon.slotY).toBeCloseTo(icon.rowY, 1);
    expect(icon.svgY).toBeCloseTo(icon.rowY, 1);
    expect(icon.viewBox).toBe('0 0 24 24');
    expect(icon.drawing[0]!).toBeGreaterThanOrEqual(0.8);
    expect(icon.drawing[1]!).toBeGreaterThanOrEqual(0.8);
    expect(icon.drawing[2]!).toBeLessThanOrEqual(23.2);
    expect(icon.drawing[3]!).toBeLessThanOrEqual(23.2);
    expect(icon.stroke).toBe(icon.iconColor);
    expect(icon.strokeWidth).toBe('1.6px');
    expect(icon.fill).toBe('none');
    expect(icon.iconColor).toBe(icon.textColor);
    expect(icon.hidden).toBe(true);
    expect(icon.focusable).toBe('false');
    expect(icon.tabIndex === null || Number(icon.tabIndex) < 0).toBe(true);
    expect(icon.label).toBeTruthy();
    expect(icon.title).toBe(icon.label);
  }
};

const expectTeamSwitchGeometry = async (selector: Locator, height: number, expanded: boolean) => {
  const geometry = await selector.evaluate(element => {
    const button = element.getBoundingClientRect();
    const avatar = element.querySelector<HTMLElement>('.team-avatar')!.getBoundingClientRect();
    const arrow = element.querySelector<SVGSVGElement>('svg.team-chevron');
    const arrowBox = arrow?.getBoundingClientRect();
    const path = arrow?.querySelector('path');
    const drawing = path?.getBBox();
    const name = element.querySelector<HTMLElement>('.team-switch-name')!.getBoundingClientRect();
    const center = (box: DOMRect) => (box.top + box.bottom) / 2;
    return {
      width: button.width, height: button.height, avatar: [avatar.width, avatar.height],
      avatarCenter: center(avatar) - center(button), nameCenter: center(name) - center(button),
      arrowCenter: arrowBox ? center(arrowBox) - center(button) : null,
      arrowSize: arrowBox ? [arrowBox.width, arrowBox.height] : null,
      viewBox: arrow?.getAttribute('viewBox'), hidden: arrow?.getAttribute('aria-hidden'), focusable: arrow?.getAttribute('focusable'),
      drawingCenter: drawing ? [drawing.x + drawing.width / 2, drawing.y + drawing.height / 2] : null,
    };
  });
  expect(geometry.height).toBe(height);
  if (height === 44) expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.avatar).toEqual([24, 24]);
  expect(Math.abs(geometry.avatarCenter)).toBeLessThanOrEqual(1);
  expect(geometry.viewBox).toBe('0 0 12 12');
  expect(geometry.hidden).toBe('true');
  expect(geometry.focusable).toBe('false');
  if (expanded) {
    expect(geometry.drawingCenter).toEqual([6, 6]);
    expect(Math.abs(geometry.nameCenter)).toBeLessThanOrEqual(1);
    expect(geometry.arrowSize).toEqual([12, 12]);
    expect(Math.abs(geometry.arrowCenter!)).toBeLessThanOrEqual(1);
  } else await expect(selector.locator('.team-chevron')).toBeHidden();
};

const expectIconState = async (link: Locator, color: string) => {
  await expect(link.locator('.nav-icon svg')).toHaveCSS('color', color);
  await expect(link.locator('.nav-text')).toHaveCSS('color', color);
};

for (const width of [320, 390, 740, 741, 1360]) {
  for (const locale of ['en', 'zh-CN']) {
    test(`groups long navigation without overflow at ${width}px in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const reads = await install(page);
      await page.goto(`/teams/${teamId}`);
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const chinese = locale === 'zh-CN';
      await expect(page.getByRole('heading', { name: chinese ? '项目' : 'Projects', exact: true })).toBeVisible();
      const breadcrumb = page.locator('.crumb');
      const eyebrow = page.locator('.project-list-heading .eyebrow');
      await expect(breadcrumb).toContainText(longName);
      await expect(eyebrow).toHaveText(longName);
      for (const element of [breadcrumb, eyebrow]) {
        expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        const box = (await element.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const sidebar = page.locator('.sidebar');
      if (width <= 740) {
        await expect(sidebar).toBeHidden();
        await expect(sidebar).toHaveAttribute('inert', '');
        expect(await page.locator('.workspace').evaluate(element => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width }))).toEqual({ x: 0, width });
        const opener = page.getByRole('button', { name: chinese ? '打开导航' : 'Open navigation' });
        await expect(opener).toHaveAttribute('aria-controls', 'workspace-sidebar');
        await expect(opener).toHaveAttribute('aria-expanded', 'false');
        const box = (await opener.boundingBox())!;
        expect([box.width, box.height]).toEqual([44, 44]);
        await page.getByRole('button', { name: chinese ? '打开导航' : 'Open navigation' }).click();
        expect((await sidebar.boundingBox())!.width).toBe(220);
      } else expect((await sidebar.boundingBox())!.width).toBe(190);
      await expectIconColumn(sidebar);
      const selector = sidebar.locator('.team-switch');
      await expectTeamSwitchGeometry(selector, width <= 740 ? 44 : 36, true);
      await expect(selector).toHaveAttribute('title', new RegExp(chinese ? '团队' : 'Team'));
      await expect(selector).toHaveAttribute('title', new RegExp(longName.trim().slice(0, 20)));
      await expect(selector).toHaveAttribute('aria-label', chinese ? `切换 Team: 团队, ${longName}` : `Switch Team: Team, ${longName}`);
      await expect(selector.locator('.team-switch-text')).toHaveText(longName);
      await expect(selector.locator('.team-switch-text > *')).toHaveCount(1);
      const geometry = await selector.evaluate(element => {
        const name = element.querySelector<HTMLElement>('.team-switch-name')!;
        const avatar = element.querySelector<HTMLElement>('.team-avatar')!;
        const arrow = element.querySelector<HTMLElement>('.team-chevron')!;
        const parent = element.getBoundingClientRect(), arrowBox = arrow.getBoundingClientRect(), nameBox = name.getBoundingClientRect(), avatarBox = avatar.getBoundingClientRect();
        return { truncated: name.scrollWidth > name.clientWidth, arrowRight: arrowBox.right, parentRight: parent.right, centerDifference: Math.abs((nameBox.top + nameBox.bottom - avatarBox.top - avatarBox.bottom) / 2), textHeight: element.querySelector<HTMLElement>('.team-switch-text')!.getBoundingClientRect().height, nameHeight: nameBox.height };
      });
      expect(geometry.truncated).toBe(true);
      expect(geometry.arrowRight).toBeLessThanOrEqual(geometry.parentRight);
      expect(geometry.centerDifference).toBeLessThanOrEqual(1);
      expect(geometry.textHeight).toBe(geometry.nameHeight);
      const groups = sidebar.locator('.sidebar-group');
      await expect(groups).toHaveCount(3);
      const tasks = sidebar.getByRole('link', { name: chinese ? '进行中的任务' : 'In-progress tasks', exact: true });
      await expect(tasks).toHaveCount(1);
      await expect(tasks).toHaveAttribute('href', '/my-tasks');
      await expect(tasks).toHaveAttribute('title', chinese ? '进行中的任务' : 'In-progress tasks');
      await expect(tasks).not.toHaveAttribute('aria-current');
      await expectIconState(tasks, 'rgb(167, 176, 194)');
      await tasks.hover();
      await expectIconState(tasks, 'rgb(240, 241, 255)');
      await page.mouse.move(width - 1, 0);
      await expectIconState(tasks, 'rgb(167, 176, 194)');
      await expect(groups.nth(1).locator('a[href="/my-tasks"]')).toHaveCount(0);
      expect(await groups.nth(0).evaluate(group => {
        const selector = group.querySelector('.team-selector')!;
        const tasks = group.querySelector('a[href="/my-tasks"]')!;
        const projects = group.querySelector('.sidebar-projects')!.previousElementSibling!;
        return Boolean(selector.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING)
          && tasks.nextElementSibling === projects;
      })).toBe(true);
      await selector.focus();
      await page.keyboard.press('Tab');
      await expect(tasks).toBeFocused();
      await expectIconState(tasks, 'rgb(167, 176, 194)');
      expect(await tasks.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
      await page.keyboard.press('Tab');
      await expect(groups.nth(0).getByRole('link', { name: chinese ? '项目' : 'Projects', exact: true })).toBeFocused();
      await expect(groups.nth(0).getByRole('link', { name: chinese ? '项目' : 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
      await expectIconState(groups.nth(0).getByRole('link', { name: chinese ? '项目' : 'Projects', exact: true }), 'rgb(240, 241, 255)');
      await expect(groups.nth(1).locator('.nav-label')).toHaveText(chinese ? '我的' : 'My');
      await expect(groups.nth(2).locator('.nav-label')).toHaveText(chinese ? '工具' : 'Tools');
      const main = sidebar.locator('.sidebar-main');
      await expect(sidebar.locator('.sidebar-project-link')).toHaveCount(28);
      const before = reads();
      await groups.nth(2).getByRole('link', { name: chinese ? '测试会话' : 'Test sessions' }).scrollIntoViewIfNeeded();
      expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      expect(await main.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await main.evaluate(element => { element.scrollTop = 0; });
      await selector.click();
      await expect(sidebar.locator('.team-options')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(selector).toBeFocused();
      await expect(sidebar.locator('.team-options')).toBeHidden();
      if (width <= 740) {
        await expect(sidebar).toHaveAttribute('role', 'dialog');
        await page.keyboard.press('Escape');
        await expect(sidebar).not.toHaveAttribute('role', 'dialog');
        await expect(page.getByRole('button', { name: chinese ? '打开导航' : 'Open navigation' })).toBeFocused();
      } else {
        await page.getByRole('button', { name: chinese ? '折叠侧栏' : 'Collapse sidebar' }).click();
        expect((await sidebar.boundingBox())!.width).toBe(68);
        await expect(selector.locator('.team-switch-text')).toBeHidden();
        await expectTeamSwitchGeometry(selector, 36, false);
        await expect(sidebar.locator('.sidebar-projects')).toBeHidden();
        await expect(tasks).toBeVisible();
        await expectIconColumn(sidebar);
      }
      expect(reads()).toBe(before);
      if (width <= 740) await page.getByRole('button', { name: chinese ? '打开导航' : 'Open navigation' }).click();
      const layout = () => tasks.evaluate(link => {
        const row = link.getBoundingClientRect();
        const icon = link.querySelector('.nav-icon')!.getBoundingClientRect();
        const text = link.querySelector('.nav-text')!.getBoundingClientRect();
        return [row.width, row.height, icon.x - row.x, icon.y - row.y, text.x - row.x, text.y - row.y];
      });
      const beforeSelection = await layout();
      await tasks.click();
      await expect(page).toHaveURL(/\/my-tasks$/);
      await expect(breadcrumb).toContainText(chinese ? '我的' : 'My');
      await expect(breadcrumb).toContainText(chinese ? '进行中的任务' : 'In-progress tasks');
      await expect(tasks).toHaveAttribute('aria-current', 'page');
      if (width <= 740) {
        await expect(sidebar).not.toHaveAttribute('role', 'dialog');
        await page.getByRole('button', { name: chinese ? '打开导航' : 'Open navigation' }).click();
      }
      await expectIconState(tasks, 'rgb(240, 241, 255)');
      expect(await layout()).toEqual(beforeSelection);
    });
  }
}


test('keeps the long Team breadcrumb link usable on settings at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await install(page);
  await page.goto(`/teams/${teamId}/settings`);
  const breadcrumb = page.locator('.crumb');
  const teamLink = breadcrumb.getByRole('link', { name: longName });
  await expect(teamLink).toHaveAttribute('href', `/teams/${teamId}`);
  await expect(teamLink).toBeVisible();
  expect(await breadcrumb.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('Personal GitHub Apps replaces Team settings and retains its selected icon', async ({ page }) => {
  await install(page);
  await page.goto(`/teams/${personalId}/github-apps`);
  const sidebar = page.locator('.sidebar');
  const personalApps = sidebar.getByRole('link', { name: 'GitHub Apps', exact: true });
  await expect(personalApps).toHaveAttribute('href', `/teams/${personalId}/github-apps`);
  await expect(personalApps).toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('link', { name: 'Team settings' })).toHaveCount(0);
  await expectIconColumn(sidebar);
  await expectIconState(personalApps, 'rgb(240, 241, 255)');
});

test('hides Webhooks when its capability is unavailable', async ({ page }) => {
  await install(page, false);
  const capability = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/webhook-event-types');
  await page.goto(`/teams/${teamId}`);
  expect((await capability).status()).toBe(404);
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Webhooks' })).toHaveCount(0);
  await expect(sidebar.locator('.sidebar-group > a.nav-button')).toHaveCount(8);
});


test('keeps the Team switcher touch-sized on a wide coarse-pointer device', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 800 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await install(page);
    await page.goto(`/teams/${teamId}`);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const selector = page.locator('.sidebar .team-switch');
    await expectTeamSwitchGeometry(selector, 44, true);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expectTeamSwitchGeometry(selector, 44, false);
  } finally {
    await context.close();
  }
});

for (const width of [320, 390, 740]) {
  test(`keeps the navigation opener reachable and restores focus at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 360 });
    const reads = await install(page);
    await page.goto(`/teams/${teamId}`);
    const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
    const sidebar = page.locator('.sidebar');
    const workspace = page.locator('.workspace');
    await expect(opener).toBeVisible();
    await expect(sidebar).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(opener).toBeInViewport();
    const openerBox = (await opener.boundingBox())!;
    const accountBox = (await page.getByRole('button', { name: /^Account menu:/ }).boundingBox())!;
    const localeBox = (await page.getByRole('combobox', { name: '语言 / Language' }).boundingBox())!;
    expect(openerBox.x + openerBox.width).toBeLessThanOrEqual(localeBox.x);
    expect(localeBox.x + localeBox.width).toBeLessThanOrEqual(accountBox.x);
    const count = reads();
    for (const dismiss of ['close', 'backdrop', 'escape'] as const) {
      await opener.click();
      const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
      const close = drawer.getByRole('button', { name: 'Close navigation', exact: true });
      await expect(close).toBeFocused();
      if (dismiss === 'close') await page.screenshot({ path: info.outputPath('mobile-drawer.png') });
      expect(await close.evaluate(element => [element.getBoundingClientRect().width, element.getBoundingClientRect().height])).toEqual([44, 44]);
      await expect(workspace).toHaveAttribute('inert', '');
      await page.keyboard.press('Shift+Tab');
      await expect(drawer.getByRole('link', { name: 'Test Sessions', exact: true })).toBeFocused();
      await page.keyboard.press('Tab'); await expect(close).toBeFocused();
      if (dismiss === 'close') await close.click();
      else if (dismiss === 'backdrop') await page.locator('.sidebar-backdrop').click({ position: { x: width - 8, y: 20 } });
      else await page.keyboard.press('Escape');
      await expect(sidebar).toBeHidden();
      await expect(workspace).not.toHaveAttribute('inert');
      await expect(opener).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
    }
    expect(reads()).toBe(count);
    await opener.click();
    await page.getByRole('dialog', { name: 'Workspace navigation' }).getByRole('link', { name: 'My Workers', exact: true }).click();
    await expect(page).toHaveURL(/\/workers$/);
    await expect(page.getByRole('main')).toBeFocused();
    await expect(sidebar).toBeHidden();
    await page.screenshot({ path: info.outputPath('mobile-shell.png'), fullPage: true });
  });
}

test('closes the drawer across breakpoints and keeps the desktop collapse preference', async ({ page }) => {
  await install(page); await page.goto(`/teams/${teamId}`);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  const stored = await page.evaluate(() => localStorage.getItem('daynight.web.sidebar.collapsed'));
  const sidebar = page.locator('.sidebar');
  expect((await sidebar.boundingBox())!.width).toBe(68);
  await page.setViewportSize({ width: 740, height: 800 });
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(sidebar).toBeHidden(); await opener.click();
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toBeVisible();
  await page.setViewportSize({ width: 741, height: 800 });
  await expect(sidebar).not.toHaveAttribute('role', 'dialog');
  expect((await sidebar.boundingBox())!.width).toBe(68);
  await expect(page.locator('.workspace')).not.toHaveAttribute('inert');
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  expect(await page.evaluate(() => localStorage.getItem('daynight.web.sidebar.collapsed'))).toBe(stored);
  await page.setViewportSize({ width: 740, height: 800 });
  await expect(sidebar).toBeHidden(); await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await page.reload(); await expect(sidebar).toBeHidden(); await expect(opener).toHaveAttribute('aria-expanded', 'false');
});

test('removes the Team popover when crossing the navigation breakpoint', async ({ page }) => {
  await install(page); await page.goto(`/teams/${teamId}`);
  const selector = page.locator('.team-switch');
  await selector.click(); await expect(page.locator('.team-options')).toBeVisible();
  await page.setViewportSize({ width: 740, height: 800 });
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.team-options')).toBeHidden();
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(opener).toBeFocused(); await opener.click();
  await selector.click(); await expect(page.locator('.team-options')).toBeVisible();
  await page.setViewportSize({ width: 741, height: 800 });
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toHaveCount(0);
  await expect(page.locator('.team-options')).toBeHidden();
  await expect(page.locator('.workspace')).not.toHaveAttribute('inert');
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});
