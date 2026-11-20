import { expect, test, type Locator, type Page } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const time = '2026-10-20T09:00:00Z';
type Locale = 'en' | 'zh-CN';
type Surface = 'team' | 'account';
type Gate = { promise: Promise<void>; release: () => void };
const gate = (): Gate => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };

const install = async (page: Page, locale: Locale) => {
  const state = { fail: false, populated: false, allowSecrets: false, role: 'admin' as 'admin' | 'member', hold: null as Gate | null, reads: [] as string[], writes: [] as string[] };
  const personal = { id: personalId, kind: 'personal', name: null };
  const membership = (id: string) => ({ teamId: id, userId, role: id === personalId ? 'admin' : state.role, version: 1, createdAt: time, updatedAt: time });
  const team = (id: string) => ({ ...(id === personalId ? personal : { id: teamId, kind: 'ordinary', name: 'Layout Team' }), version: 1, createdAt: time, updatedAt: time, membership: membership(id) });
  await page.addInitScript(language => localStorage.setItem('daynight.web.locale', language), locale);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    if (request.method() !== 'GET') {
      state.writes.push(`${request.method()} ${path}`);
      if (state.allowSecrets && request.method() === 'POST' && path === `/api/v1/teams/${teamId}/invitations`) return send({ id: '00000000-0000-4000-8000-000000000051', teamId, createdBy: userId, createdAt: time, expiresAt: '2099-10-27T09:00:00Z', consumedBy: null, consumedAt: null, revokedAt: null, link: `${new URL(request.url()).origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` }, 201);
      if (state.allowSecrets && request.method() === 'POST' && path === '/api/v2/me/tokens') return send({ id: '00000000-0000-4000-8000-000000000052', name: 'Device', createdAt: time, expiresAt: null, description: null, lastUsedAt: null, token: 'once-only-secret' }, 201);
      return send({ error: { code: 'unexpected_write', message: 'Unexpected write', requestId: 'fixture' } }, 500);
    }
    state.reads.push(path);
    if (path === '/api/v1/me') return send({ id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [team(teamId)], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}` || path === `/api/v1/teams/${teamId}`) return send(team(path.split('/').at(-1)!));
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}/members`) return send({ items: [{ ...membership(teamId), profile: { name: 'Alice', email: null, avatarUrl: null } }] });
    if (path === '/api/v2/me/tokens' || path === '/api/v3/oauth/grants' || path === `/api/v1/teams/${teamId}/invitations`) {
      const hold = state.hold;
      if (hold) await hold.promise;
      if (state.fail) return send({ error: { code: 'unavailable', message: 'Layout fixture could not read the list.', requestId: 'fixture' } }, 503);
      const credentialId = '00000000-0000-4000-8000-000000000051', expiresAt = '2099-10-20T09:00:00Z';
      if (path === '/api/v3/oauth/grants') return send({ userId, grants: state.populated ? [{ id: credentialId, clientName: 'Local editor', clientId: 'https://editor.example', resource: 'https://service.example/mcp', scope: 'daynight:mcp', createdAt: time, expiresAt, description: null, lastUsedAt: null, revokedAt: null, status: 'active' }] : [] });
      if (path === '/api/v2/me/tokens') return send({ items: state.populated ? [{ id: credentialId, name: 'Local CLI', createdAt: time, expiresAt, description: null, lastUsedAt: null }] : [] });
      return send({ items: state.populated ? [{ id: credentialId, teamId, createdBy: userId, createdAt: time, expiresAt, consumedBy: null, consumedAt: null, revokedAt: null }] : [] });
    }
    if (path === '/api/v1/me/worker-prompt') return send({ scope: 'user', scopeId: userId, text: '', revision: '0', updatedAt: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  return state;
};

const open = async (page: Page, surface: Surface, locale: Locale) => {
  await page.goto(surface === 'team' ? `/teams/${teamId}/members` : '/account');
  if (surface === 'account') await page.getByRole('link', { name: locale === 'en' ? 'Access credentials' : '访问凭据', exact: true }).click();
  const headers = page.locator(surface === 'team' ? '.team-invitations .panel-heading' : '.panel-heading-description:visible');
  await expect(headers).toHaveCount(surface === 'team' ? 1 : 2);
  return headers;
};

const measure = async (header: Locator) => header.evaluate(element => {
  const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const style = getComputedStyle(element), paragraph = element.querySelector('p')!, title = element.querySelector('h2')!, action = element.querySelector(':scope > button');
  const p = rect(paragraph), outer = rect(element);
  return {
    outer, p, title: rect(title), action: action ? rect(action) : null,
    left: outer.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
    right: outer.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
    lines: p.height / parseFloat(getComputedStyle(paragraph).lineHeight),
    fontSize: getComputedStyle(paragraph).fontSize,
    overflow: element.scrollWidth > element.clientWidth,
  };
});

const expectLayout = async (header: Locator, width: number) => {
  const box = await measure(header);
  expect(box.overflow).toBe(false);
  expect(box.p.left).toBeGreaterThanOrEqual(box.left - 1);
  expect(box.p.right).toBeLessThanOrEqual(box.right + 1);
  if (width <= 600) {
    expect(Math.abs(box.p.left - box.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.p.right - box.right)).toBeLessThanOrEqual(1);
    expect(box.p.top).toBeGreaterThanOrEqual(Math.max(box.title.bottom, box.action?.bottom ?? 0) + 3);
  }
  if (box.action) {
    expect(box.title.right).toBeLessThanOrEqual(box.action.left - (width <= 600 ? 9 : 0));
    expect(box.action.right).toBeLessThanOrEqual(box.right + 1);
    if (width > 600) expect(box.p.right).toBeLessThanOrEqual(box.action.left);
  }
  return box;
};

for (const locale of ['en', 'zh-CN'] as const) for (const surface of ['team', 'account'] as const) {
  test(`${surface} descriptions use their row in ${locale}`, async ({ page }, testInfo) => {
    const state = await install(page, locale);
    state.populated = locale === 'en';
    const headers = await open(page, surface, locale);
    await expect(headers.first().locator(':scope > button')).toBeEnabled();
    await expect(headers.first().locator('..').locator(':scope > .row')).toHaveCount(state.populated ? 1 : 0);
    const evidence = [];
    for (const width of [320, 375, 390, 600, 601, 768, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const header of await headers.all()) {
        const box = await expectLayout(header, width);
        expect(box.fontSize).toBe('14px');
        if (width === 320 && locale === 'en') {
          expect(Math.round(box.lines)).toBe(surface === 'team' ? 3 : 2);
        }
        evidence.push({ width, ...box });
      }
      if (width === 320 || width === 1360) {
        await headers.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`${surface}-${locale}-${width}.png`) });
      }
    }
    await testInfo.attach('geometry', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    expect(state.writes).toEqual([]);
  });
}

test('long text, missing descriptions and absent actions keep the selective layout contained', async ({ page }) => {
  await install(page, 'en');
  const headers = await open(page, 'account', 'en');
  for (const width of [320, 600]) {
    await page.setViewportSize({ width, height: 900 });
    const header = headers.first();
    await header.evaluate(element => {
      element.querySelector('h2')!.textContent = 'CredentialManagementWithAnUnbrokenTitleAndMoreDetails';
      element.querySelector('p')!.textContent = 'A longer explanation remains readable across the complete available width. '.repeat(3);
      element.querySelector(':scope > button')!.textContent = 'CreateAccessCredentialWithAnUnbrokenActionLabel';
    });
    await expectLayout(header, width);
  }
  const header = headers.first();
  await header.locator('p').evaluate(element => element.remove());
  expect(await header.evaluate(element => {
    const title = element.querySelector('h2')!.getBoundingClientRect(), action = element.querySelector(':scope > button')!.getBoundingClientRect();
    return title.right <= action.left && action.right <= element.getBoundingClientRect().right;
  })).toBe(true);
  await page.reload();
  await expect(headers).toHaveCount(2);
  await headers.first().locator(':scope > button').evaluate(element => element.remove());
  const full = await expectLayout(headers.first(), 600);
  expect(Math.abs(full.title.width - (full.right - full.left))).toBeLessThanOrEqual(1);
});

test('loading and failed lists retain full-width explanations and disabled entry points', async ({ page }) => {
  const state = await install(page, 'en');
  for (const surface of ['team', 'account'] as const) {
    state.fail = false; state.hold = gate();
    const headers = await open(page, surface, 'en');
    for (const header of await headers.all()) { await expect(header.locator(':scope > button')).toBeDisabled(); await expectLayout(header, 320); }
    state.fail = true; state.hold.release(); state.hold = null;
    await expect(page.getByRole('alert').first()).toBeVisible();
    for (const header of await headers.all()) await expectLayout(header, 320);
    if (surface === 'team') await expect(headers.first().locator(':scope > button')).toBeDisabled();
    else await expect(headers.first().locator(':scope > button')).toBeDisabled();
  }
  expect(state.writes).toEqual([]);
});

test('ordinary members retain their roster without invitation management controls', async ({ page }) => {
  const state = await install(page, 'en'); state.role = 'member';
  await page.goto(`/teams/${teamId}/members`);
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await expect(page.locator('.team-member-row')).toHaveCount(1);
  await expect(page.locator('.team-invitations .panel-heading')).toHaveCount(0);
  expect(state.reads).not.toContain(`/api/v1/teams/${teamId}/invitations`);
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`header actions preserve pointer, keyboard, touch and focus in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  for (const surface of ['team', 'account'] as const) {
    const headers = await open(page, surface, locale);
    const action = headers.first().locator(':scope > button');
    await expect(action).toBeEnabled();
    for (const mode of ['pointer', 'keyboard', 'touch']) {
      await action.scrollIntoViewIfNeeded();
      expect(await action.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
      if (mode === 'pointer') await action.click();
      else if (mode === 'touch') await action.tap();
      else { await action.focus(); await page.keyboard.press('Enter'); }
      const dialog = page.getByRole('dialog', { name: surface === 'team' ? locale === 'en' ? 'Create Team invitation' : '创建 Team 邀请链接' : locale === 'en' ? 'Create personal access token' : '创建个人访问令牌', exact: true });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden(); await expect(action).toBeFocused();
    }
    if (surface === 'account') {
      const refresh = headers.nth(1).locator(':scope > button');
      const before = state.reads.filter(path => path === '/api/v3/oauth/grants').length;
      await refresh.tap();
      await expect.poll(() => state.reads.filter(path => path === '/api/v3/oauth/grants').length).toBe(before + 1);
      await expect(refresh).toBeEnabled();
    }
  }
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const hasTouch of [false, true]) {
  test(`shared credential and account text sizes follow their scope in ${locale} (touch=${hasTouch})`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch });
    const page = await context.newPage();
    try {
      const state = await install(page, locale);
      state.allowSecrets = true;
      const headers = await open(page, 'team', locale);
      await headers.first().locator(':scope > button').click();
      await page.getByRole('dialog').locator('.dialog-footer .primary').click();
      const invitation = page.getByLabel(locale === 'en' ? 'One-time invitation link' : '一次性邀请链接');
      await expect(invitation).toHaveValue(/#dnteam_/);
      await expect(invitation).toHaveAttribute('readonly', '');
      await expect(invitation).toHaveAttribute('data-touch-text', 'responsive');
      for (const width of [320, 1000]) for (const size of [12, 24]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value}px`; }, size);
        await expect(invitation).toHaveCSS('font-size', `${width <= 800 || hasTouch ? Math.max(size, 16) : size * .875}px`);
      }
      await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'I have saved it, close' : '我已保存，关闭' }).click();

      const accountHeaders = await open(page, 'account', locale);
      await accountHeaders.first().locator(':scope > button').click();
      await page.getByLabel(locale === 'en' ? 'Token name' : '令牌名称').fill('Device');
      await page.getByRole('dialog').locator('.dialog-footer .primary').click();
      const token = page.getByLabel(locale === 'en' ? 'One-time access token' : '一次性访问令牌');
      await expect(token).toHaveValue('once-only-secret');
      await expect(token).toHaveAttribute('readonly', '');
      await expect(token).not.toHaveAttribute('data-touch-text');
      for (const width of [320, 1000]) for (const size of [12, 24]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value}px`; }, size);
        await expect(token).toHaveCSS('font-size', `${size * .875}px`);
      }
      await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'I have saved it, close' : '我已保存，关闭' }).click();
      await page.locator('.account-button').click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      for (const size of [12, 24]) {
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value}px`; }, size);
        await expect(menu.locator('.account-menu-item').first()).toHaveCSS('font-size', `${size * .875}px`);
      }
      expect(state.writes).toEqual([`POST /api/v1/teams/${teamId}/invitations`, 'POST /api/v2/me/tokens']);
    } finally { await context.close(); }
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const hasTouch of [false, true]) {
  test(`Team name editing uses responsive input text in ${locale} (touch=${hasTouch})`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch });
    const page = await context.newPage();
    try {
      const state = await install(page, locale);
      await page.goto(`/teams/${teamId}/settings`);
      await page.locator('.team-settings-name button').click();
      const dialog = page.getByRole('dialog', { name: locale === 'en' ? 'Edit Team name' : '修改 Team 名称' });
      const name = dialog.getByLabel(locale === 'en' ? 'Team name' : 'Team 名称');
      await expect(name).toHaveValue('Layout Team');
      await expect(name).not.toHaveAttribute('data-touch-text');
      for (const width of [320, 1000]) for (const size of [12, 24]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value}px`; }, size);
        await expect(name).toHaveCSS('font-size', `${width <= 800 || hasTouch ? Math.max(size, 16) : size * .875}px`);
      }
      await name.fill('Changed Team');
      await expect(name).toHaveValue('Changed Team');
      expect(state.writes).toEqual([]);
    } finally { await context.close(); }
  });
}
