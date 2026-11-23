import { expect, test, type Page, type Route } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000101';
const actorId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const base = `/projects/${projectId}/settings`;
const team = { id: teamId, kind: 'personal', name: null };
const project = { id: projectId, name: 'Example project', repoUrl: 'https://github.com/example/project', ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const access = { projectId, ownerTeam: team, ownership: { teamId, version: 1n }, effectiveRole: 'admin', teamRole: 'admin', canTransfer: true, directGrant: { projectId, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time } };

const install = async (page: Page, name = 'Example project') => {
  const shownProject = { ...project, name };
  const writes: string[] = [];
  await page.context().route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } });
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (path === '/api/v1/me') return send({ id: actorId, personalTeam: team, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [shownProject], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(shownProject);
    if (path === `/api/v1/projects/${projectId}/access`) return send(access);
    if (path === `/api/v1/projects/${projectId}/members`) return send({ actorAccess: access, items: [{ userId: actorId, profile: { name: 'Alice', email: null, avatarUrl: null }, effectiveRole: 'admin', inheritedFrom: null, directGrant: access.directGrant }] });
    if (path === `/api/v1/projects/${projectId}/invitations`) return send({ items: [] });
    if (path === `/api/v1/me/projects/${projectId}/worker-prompt`) return send({ scope: 'project', scopeId: projectId, revision: '0', text: '', updatedAt: null });
    if (path === `/api/v1/teams/${teamId}/github/apps`) return send({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/github`) return send({ projectId, version: '1', revision: '0', serviceAvailable: true, syncEnabled: false, connection: 'not_connected', repository: null, installation: null, canManageConnection: true, app: null, grantId: null, pollIntervalMinutes: 5, initializing: false, poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null } });
    if (path === `/api/v1/projects/${projectId}/pull-requests`) return send({ projectId, revision: '0', items: [], total: '0', counts: { active: '0', closed: '0', merged: '0', all: '0' }, nextCursor: null, previousCursor: null });
    return send({ error: { code: 'not_found', message: 'not_found', requestId: 'test' } }, 404);
  });
  return writes;
};

const section = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project settings sections' }).getByRole('link', { name });

const expectSelectedVisible = async (page: Page) => {
  await expect.poll(() => page.locator('.project-settings-tabs').evaluate(element => {
    const nav = element.getBoundingClientRect(), link = element.querySelector('[aria-current="page"]')!.getBoundingClientRect();
    const left = nav.left + element.clientLeft + 4, right = left + element.clientWidth - 8;
    return getComputedStyle(element).flexDirection === 'column'
      ? element.scrollLeft === 0
      : link.width > right - left ? Math.abs(link.left - left) <= 1 : link.left >= left - 1 && link.right <= right + 1;
  })).toBe(true);
};

test('keeps the current settings link visible through resizing and language changes', async ({ page }) => {
  const writes = await install(page);
  await page.setViewportSize({ width: 1360, height: 720 });
  await page.goto(`${base}?tab=members`);
  await expect(section(page, 'Members & invitations')).toHaveAttribute('aria-current', 'page');
  for (const locale of ['en', 'zh-CN']) {
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    for (const width of [320, 375, 390, 740, 741, 768, 1360]) {
      await page.setViewportSize({ width, height: 720 });
      await expectSelectedVisible(page);
      await expect(page.locator('.project-settings-tabs [aria-current="page"]')).toHaveAttribute('href', `${base}?tab=members`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.setViewportSize({ width: 320, height: 720 });
  await expectSelectedVisible(page);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
  await expectSelectedVisible(page);
  expect(writes).toEqual([]);
});

test('member section keeps the page hierarchy and invitation usable across widths', async ({ page }) => {
  const writes = await install(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${base}?tab=members`);
  for (const locale of ['en', 'zh-CN'] as const) {
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const zh = locale === 'zh-CN';
    const heading = page.locator('.members-page-heading');
    const title = heading.getByRole('heading', { name: zh ? '项目成员' : 'Project members', level: 2 });
    const invite = heading.getByRole('button', { name: zh ? '邀请成员' : 'Invite member' });
    await expect(page.getByRole('heading', { name: 'Example project', level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: zh ? /^成员 / : /^Members /, level: 3 })).toBeVisible();
    await expect(invite).toBeEnabled();
    for (const width of [320, 375, 390, 768, 1360]) {
      await page.setViewportSize({ width, height: 640 });
      const geometry = await heading.evaluate(element => {
        const a = element.querySelector('h2')!.getBoundingClientRect(), b = element.querySelector('button')!.getBoundingClientRect();
        return { height: element.getBoundingClientRect().height, separated: a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left, sameRow: a.top < b.bottom && b.top < a.bottom };
      });
      expect(geometry.separated).toBe(true);
      if (width <= 390) expect(geometry.sameRow).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 320 && !zh) {
        expect(geometry.height).toBeLessThanOrEqual(44);
        const search = page.getByRole('searchbox', { name: 'Search and add members' });
        expect(await search.evaluate(element => element.getBoundingClientRect().top + window.scrollY)).toBeLessThanOrEqual(547.5);
      }
    }
    await page.setViewportSize({ width: 320, height: 640 });
    await invite.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(invite).toBeFocused();
    await expect(title).toBeVisible();
  }
  expect(writes).toEqual([]);
});

test('legacy members entry keeps long names and roster scrolling local', async ({ page }) => {
  const name = 'LongProjectName'.repeat(12);
  await install(page, name); await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/projects/${projectId}/members`);
  const title = page.getByRole('heading', { name, exact: true, level: 1 });
  await expect(title).toBeVisible(); await expect(title).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Project members', level: 2 })).toBeVisible();
  expect(await title.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const table = page.locator('.grant-table'); await expect(table).toBeVisible();
  expect(await table.evaluate(element => element.scrollWidth > element.clientWidth && element.querySelector('.grant-row.head')!.children.length === 5)).toBe(true);
  await table.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('member loading failure can be retried without losing the section heading', async ({ page }) => {
  await install(page); let failed = false;
  await page.route(`**/api/v1/projects/${projectId}/members`, route => {
    if (failed) return route.fallback();
    failed = true;
    return route.fulfill({ status: 503, body: JSON.stringify({ error: { code: 'unavailable', message: 'unavailable' } }), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } });
  });
  await page.setViewportSize({ width: 320, height: 640 }); await page.goto(`${base}?tab=members`);
  await expect(page.getByRole('heading', { name: 'Project members', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search and add members' })).toBeVisible();
});

test('responds to container and link geometry without changing focus or the selected section', async ({ page }) => {
  await install(page); await page.setViewportSize({ width: 390, height: 720 });
  await page.goto(`${base}?tab=members`);
  const search = page.getByRole('searchbox', { name: 'Search and add members' });
  await expect(search).toBeVisible(); await search.focus();
  const nav = page.locator('.project-settings-tabs');
  await expectSelectedVisible(page);
  // A parent layout can narrow the navigation without a viewport resize.
  await nav.evaluate(element => { element.style.width = '200px'; });
  await expectSelectedVisible(page); await expect(search).toBeFocused();
  // Earlier links can grow when fonts or status text change, moving the selected link.
  await nav.locator('a').first().evaluate(element => { element.style.paddingInline = '80px'; });
  await expectSelectedVisible(page); await expect(search).toBeFocused();
  await nav.evaluate(element => { element.style.width = '100px'; });
  await expectSelectedVisible(page);
  await nav.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const manualPosition = await nav.evaluate(element => element.scrollLeft);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await nav.evaluate(element => element.scrollLeft)).toBe(manualPosition);
  await expect(search).toBeFocused();
  await nav.locator('[aria-current="page"]').dispatchEvent('click');
  await expectSelectedVisible(page);
  await expect(page).toHaveURL(`${base}?tab=members`);
});

test('reveals changed status text while unchanged rerenders preserve manual navigation scrolling', async ({ page }) => {
  const writes = await install(page); await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${base}?tab=github`);
  const interval = page.getByLabel('Poll interval'); await expect(interval).toHaveValue('5');
  await expectSelectedVisible(page);
  await interval.fill('0');
  await expect(section(page, 'GitHub integration')).toContainText('Unsaved · Needs attention');
  await expectSelectedVisible(page); await expect(interval).toBeFocused();
  const nav = page.locator('.project-settings-tabs');
  await nav.evaluate(element => { element.scrollLeft = 0; });
  const y = await page.evaluate(() => window.scrollY);
  await interval.fill('-1');
  await expect(interval).toHaveValue('-1');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await nav.evaluate(element => element.scrollLeft)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(y);
  await expect(interval).toBeFocused();
  expect(writes).toEqual([]);
});

test('preserves independent drafts and history without issuing writes', async ({ page }) => {
  const writes = await install(page); await page.goto(base);
  const threshold = page.getByLabel('Alert threshold'); await expect(threshold).toHaveValue('60'); await threshold.fill('75');
  const length = await page.evaluate(() => history.length);
  await section(page, 'Execution & alerts').click(); expect(await page.evaluate(() => history.length)).toBe(length);
  await section(page, 'Worker prompts').click();
  const prompt = page.getByLabel('Prompt text'); await expect(prompt).toBeEditable(); await prompt.fill('A personal draft');
  await section(page, 'GitHub integration').click();
  const interval = page.getByLabel('Poll interval'); await expect(interval).toHaveValue('5'); await interval.fill('0');
  await expect(page.getByText('Enter a whole number from 1 to 2147483647 minutes.')).toBeVisible();
  await section(page, 'Project management').click();
  await expect(page.getByRole('heading', { name: 'Project ownership' })).toBeVisible();
  await page.goBack(); await expect(interval).toHaveValue('0');
  await page.goBack(); await expect(prompt).toHaveValue('A personal draft');
  await page.goBack(); await expect(threshold).toHaveValue('75');
  await page.goForward(); await expect(prompt).toHaveValue('A personal draft');
  expect(writes).toEqual([]);
});

test('opens direct and invalid URLs and retains the selection after refresh', async ({ page }) => {
  await install(page);
  for (const [tab, name] of [['execution', 'Execution & alerts'], ['prompts', 'Worker prompts'], ['github', 'GitHub integration'], ['members', 'Members & invitations'], ['management', 'Project management']] as const) {
    await page.goto(`${base}?tab=${tab}&authError=login_failed`);
    await expect(section(page, name)).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => new URL(page.url()).searchParams.has('authError')).toBe(false);
    await page.reload(); await expect(section(page, name)).toHaveAttribute('aria-current', 'page');
    await expect(section(page, name)).toHaveAttribute('href', tab === 'execution' ? base : `${base}?tab=${tab}`);
  }
  await page.goto(`/projects/${projectId}/members`);
  await expect(page).toHaveURL(`/projects/${projectId}/members`);
  await expect(section(page, 'Members & invitations')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Project members' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(`/projects/${projectId}/members`);
  await expect(section(page, 'Members & invitations')).toHaveAttribute('aria-current', 'page');
  for (const query of ['?tab=', '?tab=github&tab=prompts', '?tab=unknown']) {
    await page.goto(base + query); await expect(page.getByRole('alert')).toContainText('Invalid settings section.');
    await page.getByRole('link', { name: 'Open execution & alerts' }).click();
    await expect(section(page, 'Execution & alerts')).toHaveAttribute('aria-current', 'page');
  }
});

test('preserves a prompt draft through the legacy members address and browser history', async ({ page }) => {
  const writes = await install(page); await page.goto(`${base}?tab=prompts`);
  const prompt = page.getByLabel('Prompt text'); await expect(prompt).toBeEditable();
  await prompt.fill('A retained prompt draft');
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/projects/${projectId}/members`);
  await expect(section(page, 'Members & invitations')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Project members' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack(); await expect(prompt).toHaveValue('A retained prompt draft');
  await page.goForward(); await expect(section(page, 'Members & invitations')).toHaveAttribute('aria-current', 'page');
  await section(page, 'Worker prompts').click(); await expect(prompt).toHaveValue('A retained prompt draft');
  expect(writes).toEqual([]);
});

test('desktop links support keyboard and a new tab; history suspends and restores a dialog', async ({ page }) => {
  const writes = await install(page); await page.goto(base);
  const nav = page.getByRole('navigation', { name: 'Project settings sections' });
  await expect(nav.getByRole('link')).toHaveText(['Execution & alerts', 'Worker prompts', 'GitHub integration', 'Members & invitations', 'Project management']);
  await expect(page.getByLabel('Alert threshold')).toBeVisible();
  expect(await nav.evaluate(element => getComputedStyle(element).flexDirection)).toBe('column');
  await section(page, 'Execution & alerts').focus(); await page.keyboard.press('ArrowDown');
  await expect(section(page, 'Worker prompts')).toBeFocused();
  const popupPromise = page.context().waitForEvent('page');
  await section(page, 'Project management').click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await expect(popup).toHaveURL(`${base}?tab=management`);
  await expect(popup.getByRole('heading', { name: 'Project ownership' })).toBeVisible();
  await popup.close();
  await section(page, 'GitHub integration').click();
  await page.getByRole('button', { name: 'Connect GitHub App' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect GitHub App' }); await expect(dialog).toBeVisible();
  await page.goBack(); await expect(dialog).toBeHidden();
  await expect(section(page, 'Worker prompts')).toHaveAttribute('aria-current', 'page');
  await page.goForward(); await expect(dialog).toBeVisible();
  expect(writes).toEqual([]);
});

for (const width of [320, 390]) test(`mobile navigation is reachable at ${width}px and preserves reading position`, async ({ page }) => {
  await install(page); await page.setViewportSize({ width, height: 720 }); await page.goto(`${base}?tab=prompts`);
  const prompt = page.getByLabel('Prompt text'); await expect(prompt).toBeEditable();
  await prompt.fill(Array.from({ length: 60 }, (_, i) => `Line ${i} of the project prompt`).join('\n'));
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  const saved = await page.evaluate(() => window.scrollY);
  await section(page, 'GitHub integration').click();
  await expect(page.getByLabel('Poll interval')).toBeVisible();
  await section(page, 'Worker prompts').click();
  await expect.poll(() => page.evaluate(y => Math.abs(window.scrollY - y), saved)).toBeLessThan(3);
  const nav = page.getByRole('navigation', { name: 'Project settings sections' });
  await section(page, 'Worker prompts').focus(); await page.keyboard.press('End');
  await expect(section(page, 'Project management')).toBeFocused();
  await expect(section(page, 'Project management')).toHaveAttribute('aria-current', 'page');
  expect(await nav.evaluate(element => { const selected = element.querySelector('[aria-current="page"]')!.getBoundingClientRect(), container = element.getBoundingClientRect(); return selected.left >= container.left && selected.right <= container.right; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('labels each region and keeps long project names readable on a phone', async ({ page }) => {
  const name = 'LongProjectName'.repeat(12);
  await install(page, name); await page.setViewportSize({ width: 320, height: 720 }); await page.goto(base);
  const title = page.getByRole('heading', { name, exact: true }); await expect(title).toBeVisible();
  expect(await title.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const link = section(page, 'Execution & alerts');
  const region = page.getByRole('region', { name: 'Execution & alerts' });
  await expect(link).toHaveAttribute('aria-controls', await region.getAttribute('id') as string);
  await section(page, 'GitHub integration').focus(); await page.keyboard.press('ArrowRight');
  await expect(section(page, 'Members & invitations')).toBeFocused();
  await expect(page.getByRole('region', { name: 'Members & invitations' })).toBeVisible();
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`project member search supports loading, retry and keyboard at ${width}px (${locale})`, async ({ page }) => {
    const writes = await install(page);
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const requests: unknown[] = [];
    await page.route(`**/api/v1/projects/${projectId}/member-candidates/search`, async route => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        started.resolve(); await finish.promise;
        return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Daynight-User-ID': actorId }, body: JSON.stringify({ error: { code: 'unavailable', message: 'unavailable' } }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Daynight-User-ID': actorId }, body: JSON.stringify({ actorRole: 'admin', nextCursor: null, items: [
        { userId: actorId, profile: { name: 'Alice', email: 'alice@example.test', avatarUrl: null } },
        { userId: '00000000-0000-4000-8000-000000000002', profile: { name: 'Bob', email: 'bob@example.test', avatarUrl: null } },
      ] }) });
    });
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`${base}?tab=members`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const chinese = locale === 'zh-CN';
    const input = page.getByRole('searchbox', { name: chinese ? '搜索并添加成员' : 'Search and add members' });
    await input.fill('Alice');
    const popup = page.getByRole('dialog', { name: chinese ? '搜索用户并添加到项目' : 'Search users and add to project' });
    try {
      await started.promise;
      await expect(popup.getByRole('status')).toContainText(chinese ? '正在搜索' : 'Searching');
    } finally { finish.resolve(); }
    await expect(popup.getByRole('alert')).toContainText(chinese ? '暂时无法搜索用户' : 'Unable to search users');
    await popup.getByRole('button', { name: chinese ? '重试' : 'Retry' }).click();
    const joined = popup.getByRole('button', { name: new RegExp(`${chinese ? '已加入' : 'Joined'}.*${actorId}`) });
    await expect(joined).toHaveAttribute('aria-disabled', 'true');
    await expect(popup.getByRole('button', { name: new RegExp(`${chinese ? '添加' : 'Add'}.*00000000-0000-4000-8000-000000000002`) })).toBeVisible();
    expect(requests).toEqual([{ expectedUserId: actorId, query: 'alice', limit: 20 }, { expectedUserId: actorId, query: 'alice', limit: 20 }]);
    const bounds = await popup.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await input.focus(); await input.press('ArrowDown'); await expect(popup.locator('summary').first()).toBeFocused();
    await joined.focus(); await joined.press('Enter'); await expect(joined).toHaveAttribute('aria-disabled', 'true');
    expect(writes).toEqual([]);
    await joined.press('Escape'); await expect(input).toBeFocused(); await expect(popup).toHaveCount(0);
    await input.fill('Alice ');
    await expect(popup).toBeVisible();
    if (width === 320) {
      await page.evaluate(() => window.scrollBy(0, 100));
      await expect.poll(() => popup.evaluate(element => {
        const box = element.getBoundingClientRect();
        const title = element.querySelector('.member-search-heading')!.getBoundingClientRect();
        const hit = document.elementFromPoint(title.left + title.width / 2, title.top + title.height / 2);
        return box.height > 100 && hit !== null && element.contains(hit);
      })).toBe(true);
    }
    await page.getByRole('navigation', { name: chinese ? '项目设置分组' : 'Project settings sections' }).getByRole('link', { name: chinese ? '执行与提醒' : 'Execution & alerts' }).click();
    await expect(popup).toBeHidden();
  });
}

test('project members without administrator access do not see search', async ({ page }) => {
  await install(page);
  const memberGrant = { ...access.directGrant, role: 'member' };
  const memberAccess = { ...access, effectiveRole: 'member', teamRole: null, directGrant: memberGrant, canTransfer: false };
  await page.route(`**/api/v1/projects/${projectId}/{access,members}`, async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/access') ? memberAccess : { actorAccess: memberAccess, items: [{ userId: actorId, profile: { name: 'Alice', email: null, avatarUrl: null }, effectiveRole: 'member', inheritedFrom: null, directGrant: memberGrant }] };
    await route.fulfill({ status: 200, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } });
  });
  await page.goto(`${base}?tab=members`);
  await expect(page.getByRole('heading', { name: 'Project members' })).toBeVisible();
  await expect(page.getByText('Project administrators manage members and invitations.', { exact: false })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search and add members' })).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) for (const role of ['admin', 'member'] as const) {
  test(`project management headings and controls at ${width}px (${locale}, ${role})`, async ({ page }) => {
    const writes = await install(page);
    if (role === 'member') {
      const memberAccess = { ...access, effectiveRole: 'member', teamRole: null, canTransfer: false, directGrant: { ...access.directGrant, role: 'member' } };
      await page.route(`**/api/v1/projects/${projectId}/access`, route => route.fulfill({ status: 200, body: stringifyWireJson(memberAccess), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } }));
    }
    await page.route(`**/api/v1/projects/${projectId}/deletion-preview`, route => route.fulfill({ status: 200, body: stringifyWireJson({ observedAt: time, project: { id: projectId, name: project.name, repoUrl: project.repoUrl, ownerTeam: team }, summary: { taskCount: 2, unfinishedTaskCount: 1, attachmentCount: 3 }, activeClaims: [], nextCursor: null }), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } }));
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`${base}?tab=management`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const zh = locale === 'zh-CN';
    const owner = page.getByRole('region', { name: zh ? '项目归属' : 'Project ownership' });
    const deletion = page.getByRole('region', { name: zh ? '删除项目' : 'Delete project' });
    for (const panel of [owner, deletion]) {
      await expect(panel).toBeVisible();
      await expect(panel.locator('.panel-heading h2')).toHaveCount(1);
      await expect(panel.locator('.panel-heading p')).toHaveCount(0);
    }
    await expect(owner.getByText(teamId)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (role === 'member') {
      await expect(owner.getByText(zh ? '只有所属 Team 的 admin 可以转移项目。' : 'Only an admin of the owner Team can transfer this project.')).toBeVisible();
      await expect(owner.getByRole('button', { name: zh ? '转移项目' : 'Transfer project' })).toHaveCount(0);
      await expect(deletion.getByText(zh ? '只有所属 Team 的 admin 可以删除项目。' : 'Only an admin of the owner Team can delete this project.')).toBeVisible();
      await expect(deletion.getByRole('button', { name: zh ? '删除项目' : 'Delete project' })).toBeDisabled();
    } else {
      await owner.getByRole('button', { name: zh ? '转移项目' : 'Transfer project' }).click();
      const transfer = page.getByRole('dialog', { name: zh ? '转移项目' : 'Transfer project' });
      await expect(transfer.getByLabel(zh ? '目标 Team ID 或链接' : 'Team ID or link')).toBeVisible();
      await transfer.getByRole('button', { name: zh ? '取消' : 'Cancel' }).click();
      await deletion.getByRole('button', { name: zh ? '删除项目' : 'Delete project' }).click();
      const dialog = page.getByRole('dialog', { name: zh ? '删除此项目？' : 'Delete this project?' });
      await expect(dialog.getByText(zh ? '项目及其全部任务、依赖、Steps、讨论、附件和 Session 将退出访问；项目授权和旧邀请不再生效。' : 'The project and all its tasks, dependencies, Steps, discussions, attachments and Sessions will become inaccessible. Project grants and old invitations will no longer grant access.')).toBeVisible();
      await expect(dialog.getByText(zh ? '服务端保留历史数据和文件，产品内没有恢复入口。Git 仓库、PR、分支和本地文件不受影响。' : 'Historical data and files remain on the server; recovery is not available in the product. The Git repository, PRs, branches and local files are unaffected.')).toBeVisible();
      await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel' }).click();
    }
    expect(writes).toEqual([]);
  });
}

test('project member search uses shared responsive text at both member routes', async ({ page }) => {
  await install(page);
  for (const path of [`${base}?tab=members`, `/projects/${projectId}/members`]) {
    await page.goto(path);
    const input = page.getByRole('searchbox', { name: 'Search and add members' });
    await expect(input).toBeVisible();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const root of [12, 24]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
        await expect(input).toHaveCSS('font-size', `${width === 320 ? Math.max(root, 16) : root * 0.875}px`);
      }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  }
});

test('project prompt purposes save and clear independently while preserving hidden drafts', async ({ page }) => {
  await install(page); await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  const resources = { worker: { text: 'Project worker', revision: '2' }, reviewer: { text: 'Project reviewer', revision: '9' } };
  const writes: { path: string; body: { expectedUserId: string; revision: string; text: string } }[] = [];
  await page.route(`**/api/v1/me/projects/${projectId}/*-prompt`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const resource = path.endsWith('/reviewer-prompt') ? resources.reviewer : resources.worker;
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { expectedUserId: string; revision: string; text: string };
      writes.push({ path, body }); resource.text = body.text; resource.revision = String(Number(resource.revision) + 1);
    }
    await route.fulfill({ json: { scope: 'project', scopeId: projectId, ...resource, updatedAt: time }, headers: { 'Daynight-User-ID': actorId } });
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${base}?tab=prompts`);
  const input = page.getByLabel('Prompt text'), worker = page.getByRole('button', { name: 'Worker', exact: true }), reviewer = page.getByRole('button', { name: 'Reviewer', exact: true });
  await expect(input).toHaveValue('Project worker');
  await input.fill('Worker project draft');
  await reviewer.click(); await expect(input).toHaveValue('Project reviewer');
  await input.fill('Reviewer project 汉');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: `/api/v1/me/projects/${projectId}/reviewer-prompt`, body: { expectedUserId: actorId, revision: '9', text: 'Reviewer project 汉' } });
  await expect(page.getByText('Saved revision: 10')).toBeVisible();
  await worker.click(); await expect(input).toHaveValue('Worker project draft');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ path: `/api/v1/me/projects/${projectId}/worker-prompt`, body: { expectedUserId: actorId, revision: '2', text: 'Worker project draft' } });
  await reviewer.click(); await expect(input).toHaveValue('Reviewer project 汉');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({ path: `/api/v1/me/projects/${projectId}/reviewer-prompt`, body: { expectedUserId: actorId, revision: '10', text: '' } });
  await expect(page.getByText('Saved revision: 11')).toBeVisible();
  await input.fill('Hidden project draft'); await worker.click();
  await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('link', { name: 'My Workers' }).click();
  const dialog = page.getByRole('alertdialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /keep editing/i }).click();
  await expect(reviewer).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('Hidden project draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
