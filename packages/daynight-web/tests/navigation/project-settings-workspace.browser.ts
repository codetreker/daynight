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
    if (path === `/api/v1/projects/${projectId}/github`) return send({ projectId, version: '1', revision: '0', serviceAvailable: true, connection: 'not_connected', repository: null, installation: null, pollIntervalMinutes: 5, initializing: false, poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null } });
    if (path === `/api/v1/projects/${projectId}/pull-requests`) return send({ projectId, revision: '0', items: [], total: '0', counts: { active: '0', closed: '0', merged: '0', all: '0' }, nextCursor: null, previousCursor: null });
    return send({ error: { code: 'not_found', message: 'not_found', requestId: 'test' } }, 404);
  });
  return writes;
};

const section = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project settings sections' }).getByRole('link', { name });

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
