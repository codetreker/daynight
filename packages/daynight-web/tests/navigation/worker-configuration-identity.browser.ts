import { expect, test, type Page, type Route } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource } from '../helpers/worker-configuration';

const personalId = workerId(90), target = workerId(1), projectId = workerId(3);
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: WORKER_USER, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
const project = { id: projectId, name: 'Alpha project', repoUrl: 'https://example.test/alpha.git', settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: personalId, version: 1 }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME };
type Gate = { started: () => void; wait: Promise<void> };
const gate = () => { const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); return { value: { started: started.resolve, wait: finish.promise }, started: started.promise, finish: finish.resolve }; };
const install = async (page: Page) => {
  const state: { me: Gate | null; config: Gate | null; projects: Gate | null; writes: string[]; configReads: number; projectReads: number; revision: string; projectName: string } = { me: null, config: null, projects: null, writes: [], configReads: 0, projectReads: 0, revision: '1', projectName: project.name };
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== 'GET') state.writes.push(`${request.method()} ${path}`);
    const send = (json: unknown, extra: Record<string, string> = {}) => route.fulfill({ json, headers: { 'Daynight-User-ID': WORKER_USER, ...extra } });
    const wait = async (name: 'me' | 'config' | 'projects') => { const current = state[name]; state[name] = null; if (current) { current.started(); await current.wait; } };
    if (path === '/api/v1/me') { await wait('me'); return send(profile); }
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') {
      if (url.searchParams.get('limit') === '100') { state.projectReads++; await wait('projects'); }
      return send({ items: [{ ...project, name: state.projectName }], nextCursor: null });
    }
    if (path === `/api/v1/me/workers/${target}/configuration`) { state.configReads++; await wait('config'); return send(configurationResource(state.revision), { 'Daynight-Worker-Configuration': '1' }); }
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, headers: { 'Daynight-User-ID': WORKER_USER } });
  });
  return state;
};
// Headless Chromium does not consistently transfer focus between tabs. Simulate
// visibility events while retaining the browser's real active element and layout.
const revalidate = async (page: Page, state: Awaited<ReturnType<typeof install>>) => {
  const identity = gate(); state.me = identity.value;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await identity.started;
  return identity;
};

for (const scenario of [{ width: 1280, height: 900, locale: 'en', choose: 'Choose projects', done: 'Done' }, { width: 390, height: 844, locale: 'zh-CN', choose: '选择项目', done: '完成' }]) {
  test(`${scenario.locale} ${scenario.width}px retains unsubmitted configuration through identity and resource checks`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), scenario.locale);
    const state = await install(page);
    await page.goto(`/workers/${target}`);
    await page.locator('#worker-tab-configuration').click();
    const args = page.locator('#config-native-args'); await expect(args).toBeVisible();
    await args.fill('[invalid JSON');
    await page.getByRole('button', { name: scenario.choose }).first().click();
    const dialog = page.getByRole('dialog'), search = page.locator('#configuration-project-search');
    await expect(dialog.getByText('Alpha project')).toBeVisible();
    await dialog.getByRole('checkbox').check();
    await search.fill('Alpha');
    await search.evaluate((node: HTMLInputElement) => { node.focus(); node.setSelectionRange(1, 4); });
    const node = await dialog.elementHandle(), box = await dialog.boundingBox();
    const assertStable = async () => {
      await expect(dialog).toBeVisible(); await expect(search).toBeFocused(); await expect(search).toHaveValue('Alpha');
      expect(await dialog.evaluate((element, original) => element === original, node)).toBe(true);
      expect(await search.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 4]);
      expect(await dialog.boundingBox()).toEqual(box);
      await expect(dialog.getByRole('checkbox')).toBeChecked();
      await expect(args).toHaveValue('[invalid JSON');
      await expect(dialog.locator('.configuration-project-loading')).toHaveCount(0);
    };
    const config = gate(), projects = gate(); state.config = config.value; state.projects = projects.value;
    const identity = await revalidate(page, state);
    await assertStable(); expect(state.writes).toEqual([]);
    identity.finish(); await Promise.all([config.started, projects.started]);
    await assertStable(); expect(state.writes).toEqual([]);
    const configResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/me/workers/${target}/configuration` && response.request().method() === 'GET');
    const projectsResponse = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/v1/projects' && url.searchParams.get('limit') === '100'; });
    config.finish(); projects.finish();
    const configResult = await configResponse, projectsResult = await projectsResponse;
    expect(configResult.status()).toBe(200); expect(projectsResult.status()).toBe(200);
    expect(await configResult.finished()).toBeNull(); expect(await projectsResult.finished()).toBeNull();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => state.configReads).toBeGreaterThan(1);
    await expect.poll(() => state.projectReads).toBeGreaterThan(1);
    await assertStable();
    // Same-content reads have no visible publication marker. A separate changed
    // response verifies that both readers can publish after the stable wait.
    state.revision = '2'; state.projectName = 'Alpha updated';
    const changedConfig = gate(), changedProjects = gate(); state.config = changedConfig.value; state.projects = changedProjects.value;
    const changedIdentity = await revalidate(page, state);
    await assertStable(); changedIdentity.finish(); await Promise.all([changedConfig.started, changedProjects.started]);
    changedConfig.finish(); changedProjects.finish();
    await expect(dialog.getByText('Alpha updated')).toBeVisible();
    await expect(page.locator('.configuration-summary').getByText('2', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toBeChecked(); await expect(search).toBeFocused();
    expect(await search.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 4]);
    await expect(args).toHaveValue('[invalid JSON');
    await dialog.getByRole('button', { name: scenario.done }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.project-config-item').getByText('Alpha updated')).toBeVisible();
    await expect(args).toHaveValue('[invalid JSON');
    expect(state.writes).toEqual([]);
  });
}
