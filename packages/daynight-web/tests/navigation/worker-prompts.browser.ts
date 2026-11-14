import { expect, test, type Page, type Route } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId, workerPage } from '../helpers/workers';
import { configurationResource } from '../helpers/worker-configuration';

const target = workerId(1), personalId = workerId(90);
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: WORKER_USER, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
type Gate = { started: () => void; wait: Promise<void> };
const gate = () => { const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); return { value: { started: started.resolve, wait: finish.promise }, started: started.promise, finish: finish.resolve }; };
const install = async (page: Page) => {
  const state: { prompt: Gate | null; meReads: number; text: string; revision: string; writes: unknown[] } = { prompt: null, meReads: 0, text: 'Original prompt', revision: '1', writes: [] };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (json: unknown, extra: Record<string, string> = {}) => route.fulfill({ json, headers: { 'Daynight-User-ID': WORKER_USER, ...extra } });
    const wait = async () => { const current = state.prompt; state.prompt = null; if (current) { current.started(); await current.wait; } };
    if (path === '/api/v1/me') { state.meReads++; return send(profile); }
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/workers') return send(workerPage());
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${target}/configuration`) return send(configurationResource(), { 'Daynight-Worker-Configuration': '1' });
    if (path === `/api/v1/me/workers/${target}/prompt`) {
      if (request.method() === 'GET') await wait();
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { expectedUserId: string; revision: string; text: string };
        state.writes.push(body); state.text = body.text; state.revision = String(BigInt(state.revision) + 1n);
      }
      return send({ scope: 'worker', scopeId: target, revision: state.revision, text: state.text, updatedAt: WORKER_TIME });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, headers: { 'Daynight-User-ID': WORKER_USER } });
  });
  return state;
};
const open = async (page: Page) => {
  await page.goto('/workers');
  await page.locator(`a.worker-card[href="/workers/${target}"]`).click();
  await page.locator('[data-worker-tab="prompt"]:visible').click();
  await expect(page.locator('.worker-prompt-text')).toHaveValue('Original prompt');
};
const revalidate = async (page: Page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));
});

for (const width of [1280, 390]) test(`${width}px preserves focus, selection and history and saves long text independently`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const state = await install(page); await open(page);
  const input = page.locator('.worker-prompt-text');
  const text = 'A long prompt line with Unicode 汉字 and spaces.\n'.repeat(2500);
  await input.fill(text); await input.focus();
  await input.evaluate((element: HTMLTextAreaElement) => { element.setSelectionRange(4, 20); (window as unknown as { promptNode: Element }).promptNode = element; });
  const assertStable = async () => {
    await expect(input).toBeFocused(); await expect(input).toHaveValue(text);
    expect(await input.evaluate((element: HTMLTextAreaElement) => ({ same: element === (window as unknown as { promptNode: Element }).promptNode, start: element.selectionStart, end: element.selectionEnd }))).toEqual({ same: true, start: 4, end: 20 });
  };
  const prompt = gate(), meReads = state.meReads; state.prompt = prompt.value;
  await revalidate(page); await prompt.started; await assertStable();
  expect(state.meReads).toBe(meReads); prompt.finish();
  await expect.poll(() => state.prompt).toBeNull();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await assertStable();
  // Native input history remains attached to the same textarea across background checks.
  await page.keyboard.insertText('X');
  await expect(input).not.toHaveValue(text);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await expect(input).toHaveValue(text);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  await page.locator('#config-native-args').fill('[invalid');
  await page.locator('[data-worker-tab="prompt"]:visible').click();
  await input.focus();
  await page.keyboard.insertText('X');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(input).toHaveValue(text);
  await page.goBack();
  await expect(page.locator('[data-worker-tab="configuration"]:visible')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.locator('[data-worker-tab="prompt"]:visible')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.locator('[data-worker-tab="overview"]:visible')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  const dialog = page.getByRole('alertdialog'); await expect(dialog).toHaveCount(1);
  await dialog.getByRole('button', { name: /keep editing/i }).click();
  await expect(input).toBeFocused(); await expect(input).toHaveValue(text);
  await expect(page.locator('#config-native-args')).toHaveValue('[invalid');
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  await page.locator('.worker-prompt').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toEqual({ expectedUserId: WORKER_USER, revision: '1', text });
  await expect(page.locator('.worker-prompt').getByText('No unsaved changes')).toBeVisible();
  await expect(page.locator('#config-native-args')).toHaveValue('[invalid');
});

for (const width of [1280, 390]) test(`${width}px Worker tabs expose selection and keyboard order`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await install(page); await page.goto(`/workers/${target}`);
  const overview = page.locator('[data-worker-tab="overview"]:visible'), configuration = page.locator('[data-worker-tab="configuration"]:visible'), prompt = page.locator('[data-worker-tab="prompt"]:visible');
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  for (const [tab, panel] of [[overview, 'overview'], [configuration, 'configuration'], [prompt, 'prompt']] as const) {
    const panelElement = page.locator(`.worker-page:visible [data-worker-panel="${panel}"]`);
    const tabId = await tab.getAttribute('id'), panelId = await panelElement.getAttribute('id');
    expect(tabId).toBeTruthy(); expect(panelId).toBeTruthy();
    await expect(tab).toHaveAttribute('aria-controls', panelId!);
    await expect(panelElement).toHaveAttribute('aria-labelledby', tabId!);
  }
  await overview.focus(); await page.keyboard.press('ArrowLeft');
  await expect(prompt).toBeFocused(); await expect(prompt).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.worker-page:visible [data-worker-panel="prompt"]')).toBeVisible();
  await expect(page.locator('.worker-page:visible [data-worker-panel="overview"]')).toHaveAttribute('inert', '');
  await page.keyboard.press('ArrowRight'); await expect(overview).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(configuration).toBeFocused();
  await page.keyboard.press('End'); await expect(prompt).toBeFocused();
  await page.keyboard.press('Home'); await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute('tabindex', '0');
  await expect(configuration).toHaveAttribute('tabindex', '-1');
  await expect(prompt).toHaveAttribute('tabindex', '-1');
  expect(state.writes).toEqual([]);
});

for (const width of [1280, 320]) test(`${width}px preview scenarios retain the shared filter and unsaved prompt`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await install(page); await open(page);
  const input = page.locator('.worker-prompt-text'), preview = page.locator('.worker-prompt-preview');
  await input.fill('Unsaved prompt 汉字');
  const select = preview.getByRole('combobox'), wrapper = select.locator('..');
  await expect(wrapper).toHaveAttribute('data-density', 'filter');
  await expect(wrapper).toHaveAttribute('data-layout', 'content');
  expect(await select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['start', 'resume', 'ping']);
  for (const [value, text] of [['start', 'You are executing'], ['resume', 'Resume the original'], ['ping', '<system remider>']] as const) {
    await select.selectOption(value);
    await expect(preview.locator('pre')).toContainText(text);
    await expect(preview.locator('pre')).toContainText('Unsaved prompt 汉字');
    await expect(input).toHaveValue('Unsaved prompt 汉字');
    await expect(page.locator('.worker-prompt').getByText('Unsaved changes', { exact: true })).toBeVisible();
  }
  await select.focus();
  await select.evaluate(element => { (window as unknown as { scenarioNode: Element }).scenarioNode = element; });
  const prompt = gate(); state.prompt = prompt.value;
  await revalidate(page); await prompt.started;
  await expect(select).toBeFocused(); await expect(select).toHaveValue('ping');
  const refreshed = page.waitForResponse(response => response.url().endsWith(`/workers/${target}/prompt`) && response.request().method() === 'GET');
  prompt.finish();
  await refreshed;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await select.evaluate(element => element === (window as unknown as { scenarioNode: Element }).scenarioNode)).toBe(true);
  await expect(select).toBeFocused(); await expect(select).toHaveValue('ping');
  const control = (await select.boundingBox())!, arrow = (await wrapper.locator('svg').boundingBox())!;
  expect(control.height).toBe(32);
  expect(control.x + control.width - arrow.x - arrow.width).toBe(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: info.outputPath(`preview-${width}.png`), fullPage: true });
});
