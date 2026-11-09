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
  const state: { me: Gate | null; prompt: Gate | null; text: string; revision: string; writes: unknown[] } = { me: null, prompt: null, text: 'Original prompt', revision: '1', writes: [] };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (json: unknown, extra: Record<string, string> = {}) => route.fulfill({ json, headers: { 'Daynight-User-ID': WORKER_USER, ...extra } });
    const wait = async (name: 'me' | 'prompt') => { const current = state[name]; state[name] = null; if (current) { current.started(); await current.wait; } };
    if (path === '/api/v1/me') { await wait('me'); return send(profile); }
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/workers') return send(workerPage());
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${target}/configuration`) return send(configurationResource(), { 'Daynight-Worker-Configuration': '1' });
    if (path === `/api/v1/me/workers/${target}/prompt`) {
      if (request.method() === 'GET') await wait('prompt');
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
  await page.locator('#worker-tab-configuration').click();
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
  const identity = gate(), prompt = gate(); state.me = identity.value; state.prompt = prompt.value;
  await revalidate(page); await identity.started; await assertStable();
  identity.finish(); await prompt.started; await assertStable(); prompt.finish();
  await expect.poll(() => state.prompt).toBeNull();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await assertStable();
  // Native input history remains attached to the same textarea across background checks.
  await page.keyboard.insertText('X');
  await expect(input).not.toHaveValue(text);
  await page.keyboard.press('Control+z'); await expect(input).toHaveValue(text);
  await page.locator('#config-native-args').fill('[invalid');
  await input.focus();
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
