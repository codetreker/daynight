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
  const state: { prompt: Gate | null; reviewRead: Gate | null; write: Gate | null; meReads: number; text: string; revision: string; writes: unknown[]; resources: Record<string, { text: string; revision: string }>; promptWrites: { path: string; body: { expectedUserId: string; revision: string; text: string } }[] } = { prompt: null, reviewRead: null, write: null, meReads: 0, text: 'Original prompt', revision: '1', writes: [], resources: { user: { text: 'User worker', revision: '2' }, userReviewer: { text: 'User reviewer', revision: '5' }, workerReviewer: { text: 'Worker reviewer', revision: '7' } }, promptWrites: [] };
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
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail(), { 'Daynight-Worker-Tool-Paths': '2' });
    if (path === `/api/v1/me/workers/${target}/configuration`) return send(configurationResource(), { 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' });
    if (path === `/api/v1/me/workers/${target}/prompt`) {
      if (request.method() === 'GET') await wait();
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { expectedUserId: string; revision: string; text: string };
        state.writes.push(body); state.promptWrites.push({ path, body }); state.text = body.text; state.revision = String(BigInt(state.revision) + 1n);
        const current = state.write; state.write = null; if (current) { current.started(); await current.wait; }
      }
      return send({ scope: 'worker', scopeId: target, revision: state.revision, text: state.text, updatedAt: WORKER_TIME });
    }
    const promptResource = path === '/api/v1/me/worker-prompt' ? ['user', 'user', WORKER_USER] : path === '/api/v1/me/reviewer-prompt' ? ['userReviewer', 'user', WORKER_USER] : path === `/api/v1/me/workers/${target}/reviewer-prompt` ? ['workerReviewer', 'worker', target] : null;
    if (promptResource !== null) {
      const [key, scope, scopeId] = promptResource as [string, string, string], resource = state.resources[key]!;
      if (request.method() === 'GET' && key.endsWith('Reviewer')) { const current = state.reviewRead; state.reviewRead = null; if (current) { current.started(); await current.wait; } }
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { expectedUserId: string; revision: string; text: string };
        state.promptWrites.push({ path, body }); resource.text = body.text; resource.revision = String(BigInt(resource.revision) + 1n);
        const current = state.write; state.write = null; if (current) { current.started(); await current.wait; }
      }
      return send({ scope, scopeId, revision: resource.revision, text: resource.text, updatedAt: WORKER_TIME });
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

test('prompt content width preserves editing space and draft continuity across the column boundary', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await install(page); await open(page);
  const editor = page.locator('.worker-prompt'), input = editor.locator('textarea');
  const host = editor.locator('..'), originalInput = await input.elementHandle();
  const text = 'Keep this long instruction readable across changing navigation widths. 汉字 '.repeat(30);
  await input.fill(text); await input.focus();
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 28));

  // Host space can shrink independently of the viewport when navigation is present.
  for (const [width, stacked] of [[314, true], [620, true], [621, false], [900, false], [314, true]] as const) {
    await host.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
    await expect.poll(async () => {
      const panel = await editor.locator('.worker-prompt-panel').boundingBox();
      const aside = await editor.locator('.worker-prompt-aside').boundingBox();
      if (panel === null || aside === null) return false;
      return stacked ? aside.y >= panel.y + panel.height : aside.x >= panel.x + panel.width;
    }).toBe(true);
    expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(250);
    await expect(input).toBeFocused(); await expect(input).toHaveValue(text);
    expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true);
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([5, 28]);
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.keyboard.insertText('Edited');
  await expect(input).toHaveValue(`${text.slice(0, 5)}Edited${text.slice(28)}`);
  expect(state.writes).toEqual([]);
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
  const overview = page.locator('[data-worker-tab="overview"]:visible'), system = page.locator('[data-worker-tab="system"]:visible'), configuration = page.locator('[data-worker-tab="configuration"]:visible'), prompt = page.locator('[data-worker-tab="prompt"]:visible');
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  for (const [tab, panel] of [[overview, 'overview'], [system, 'system'], [configuration, 'configuration'], [prompt, 'prompt']] as const) {
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
  await page.keyboard.press('ArrowRight'); await expect(system).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(configuration).toBeFocused();
  await page.keyboard.press('End'); await expect(prompt).toBeFocused();
  await page.keyboard.press('Home'); await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute('tabindex', '0');
  await expect(system).toHaveAttribute('tabindex', '-1');
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

for (const location of ['user', 'worker'] as const) test(`${location} prompt purposes retain separate drafts, receipts and navigation protection`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page);
  if (location === 'user') await page.goto('/account?tab=prompt'); else await open(page);
  const input = page.locator('.worker-prompt-text');
  const workerText = location === 'user' ? 'User worker' : 'Original prompt';
  const reviewerText = location === 'user' ? 'User reviewer' : 'Worker reviewer';
  const workerRevision = location === 'user' ? '2' : '1';
  const reviewerRevision = location === 'user' ? '5' : '7';
  const workerPath = location === 'user' ? '/api/v1/me/worker-prompt' : `/api/v1/me/workers/${target}/prompt`;
  const reviewerPath = location === 'user' ? '/api/v1/me/reviewer-prompt' : `/api/v1/me/workers/${target}/reviewer-prompt`;
  const workerButton = page.getByRole('button', { name: 'Worker', exact: true });
  const reviewerButton = page.getByRole('button', { name: 'Reviewer', exact: true });
  await expect(input).toHaveValue(workerText);
  await input.fill('Worker draft');
  const reading = gate(); state.reviewRead = reading.value;
  await reviewerButton.focus(); await page.keyboard.press('Enter'); await reading.started;
  await expect(reviewerButton).toBeFocused(); await expect(reviewerButton).toHaveAttribute('aria-pressed', 'true');
  reading.finish();
  await expect(input).toHaveValue(reviewerText); await expect(reviewerButton).toBeFocused();
  await expect(page.getByText(`Saved revision: ${reviewerRevision}`)).toBeVisible();
  await input.fill('Review draft 汉');
  await workerButton.click(); await expect(input).toHaveValue('Worker draft');
  const write = gate(); state.write = write.value;
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await write.started;
  await reviewerButton.click(); await expect(input).toHaveValue('Review draft 汉');
  write.finish();
  await expect.poll(() => state.promptWrites.length).toBe(1);
  expect(state.promptWrites[0]).toEqual({ path: workerPath, body: { expectedUserId: WORKER_USER, revision: workerRevision, text: 'Worker draft' } });
  await expect(input).toHaveValue('Review draft 汉');
  await expect(page.getByText(`Saved revision: ${reviewerRevision}`)).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.promptWrites.length).toBe(2);
  expect(state.promptWrites[1]).toEqual({ path: reviewerPath, body: { expectedUserId: WORKER_USER, revision: reviewerRevision, text: 'Review draft 汉' } });
  await expect(page.getByText(`Saved revision: ${Number(reviewerRevision) + 1}`)).toBeVisible();
  const over = '汉'.repeat(10923);
  await input.fill(over);
  await expect(page.getByText('32,769 / 32,768 bytes (UTF-8)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  expect(state.promptWrites).toHaveLength(2);
  await workerButton.click(); await expect(input).toHaveValue('Worker draft');
  await reviewerButton.click(); await expect(input).toHaveValue(over);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.promptWrites.length).toBe(3);
  expect(state.promptWrites[2]).toEqual({ path: reviewerPath, body: { expectedUserId: WORKER_USER, revision: String(Number(reviewerRevision) + 1), text: '' } });
  await expect(page.getByText(`Saved revision: ${Number(reviewerRevision) + 2}`)).toBeVisible();
  await workerButton.click(); await expect(input).toHaveValue('Worker draft');
  await reviewerButton.click(); await expect(input).toHaveValue('');
  await input.fill('Hidden draft');
  await workerButton.click();
  if (location === 'user') { await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('link', { name: 'My Workers' }).click(); }
  else await page.locator('.worker-back-link').click();
  const dialog = page.getByRole('alertdialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /keep editing/i }).click();
  await expect(reviewerButton).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('Hidden draft');
});
