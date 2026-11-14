import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const personalId = workerId(90), target = workerId(1), projectId = workerId(3), inaccessibleId = workerId(4);
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: WORKER_USER, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
const project = { id: projectId, name: 'Alpha project with a long name for narrow screens', repoUrl: 'https://example.test/alpha.git', settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: personalId, version: 1 }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME };

const install = async (page: Page) => {
  const value = { ...configurationValue(), agentControlMode: null, native: { agent: 'codex' as const, model: 'model', args: ['--test'] }, projects: [{ projectId, nativeOverrides: {} }, { projectId: inaccessibleId, nativeOverrides: {} }] };
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const writes: unknown[] = [];
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown) => route.fulfill({ json, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Control-Mode': '1' } });
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [project], nextCursor: null });
    if (path === `/api/v1/me/workers/${target}/configuration`) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { value: typeof value }; writes.push(body); await wait;
        return send(configurationResource('2', body.value));
      }
      return send(configurationResource('1', value));
    }
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, headers: { 'Daynight-User-ID': WORKER_USER } });
  });
  return { release, writes };
};

// Examine the compositor's pixels: the arrow must be visible and inset, with an
// empty interval separating it from text even when the selected label is long.
const paintedArrow = async (page: Page, select: Locator) => {
  const wrapper = select.locator('..');
  await expect(wrapper).toHaveClass('native-select');
  await expect(wrapper).toHaveAttribute('data-density', 'form');
  await expect(wrapper).toHaveAttribute('data-layout', 'fill');
  const geometry = await wrapper.evaluate(element => {
    const control = element.querySelector('select')!.getBoundingClientRect();
    const arrow = element.querySelector('.native-select__arrow')!.getBoundingClientRect();
    return { inset: control.right - arrow.right, center: arrow.y + arrow.height / 2 - control.y - control.height / 2, width: arrow.width, height: arrow.height };
  });
  expect(geometry).toEqual({ inset: 12, center: 0, width: 10, height: 10 });
  await expect(wrapper.locator('.native-select__arrow')).toHaveAttribute('aria-hidden', 'true');
  const png = await wrapper.screenshot({ scale: 'css' });
  return page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const dark = (x: number, y: number) => { const i = (y * image.width + x) * 4; return Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < 200; };
    const arrow: number[] = [], gap: number[] = [];
    for (let y = 8; y < image.height - 8; y++) for (let x = image.width - 29; x < image.width - 4; x++) {
      if (dark(x, y)) (x < image.width - 24 ? gap : arrow).push(x);
    }
    return { width: image.width, height: image.height, left: Math.min(...arrow), right: Math.max(...arrow), count: arrow.length, gapCount: gap.length };
  }, png.toString('base64'));
};

for (const scenario of [
  { width: 1280, height: 900, locale: 'en' }, { width: 390, height: 844, locale: 'en' }, { width: 320, height: 844, locale: 'en' },
  { width: 1280, height: 900, locale: 'zh-CN' }, { width: 390, height: 844, locale: 'zh-CN' }, { width: 320, height: 844, locale: 'zh-CN' },
]) {
  test(`${scenario.locale} ${scenario.width}px Worker configuration arrow layout and interaction`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), scenario.locale);
    const state = await install(page);
    await page.goto(`/workers/${target}`); await page.locator('[data-worker-tab="configuration"]:visible').click();
    const agent = page.locator('#config-native-agent'); await expect(agent).toHaveValue('codex');
    await page.locator('.project-native summary').first().click();
    await page.locator('.project-native summary').nth(1).click();
    const mode = page.locator('#config-agentControlMode');
    await expect(mode.locator('option')).toHaveText(['herdr', 'web']);
    expect(await mode.evaluate(element => (element as HTMLSelectElement).selectedIndex)).toBe(-1);
    const selectors = [agent, mode, ...['agent', 'model-mode', 'args-mode'].map(suffix => page.locator(`#config-project-${projectId}-${suffix}`))];
    for (const select of selectors) {
      await expect(select).toBeVisible();
      const bounds = await paintedArrow(page, select);
      expect((await select.boundingBox())!.height).toBe(38);
      expect(bounds.count).toBeGreaterThan(3); expect(bounds.width - bounds.right).toBeGreaterThanOrEqual(10);
      expect(bounds.width - bounds.left).toBeLessThanOrEqual(24); expect(bounds.gapCount).toBe(0);
    }
    const disabled = page.locator(`#config-project-${inaccessibleId}-agent`); await expect(disabled).toBeDisabled();
    const disabledBounds = await paintedArrow(page, disabled); expect(disabledBounds.count).toBeGreaterThan(3); expect(disabledBounds.gapCount).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    for (const value of ['codex', 'copilot', 'claude']) {
      await agent.selectOption(value); await expect(agent).toHaveValue(value);
      const bounds = await paintedArrow(page, agent); expect(bounds.count).toBeGreaterThan(3); expect(bounds.gapCount).toBe(0);
    }
    await expect(page.locator('#config-native-model')).toHaveValue('');
    await expect(page.locator('#config-native-args')).toHaveValue('[]');
    await agent.scrollIntoViewIfNeeded();
    const arrow = (await agent.locator('..').locator('.native-select__arrow').boundingBox())!;
    await page.mouse.click(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2);
    await expect.poll(() => agent.evaluate(element => element.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await agent.focus(); await page.keyboard.press('ArrowUp'); await expect(agent).toHaveValue('copilot');
    await page.screenshot({ path: testInfo.outputPath(`${scenario.locale}-${scenario.width}.png`), fullPage: true });
    await page.locator('.project-native select').first().selectOption('copilot');
    await page.locator(`#config-project-${projectId}-model-mode`).selectOption('default');
    await page.locator(`#config-project-${projectId}-args-mode`).selectOption('clear');
    await page.getByRole('button', { name: scenario.locale === 'en' ? 'Discard changes' : '取消修改' }).click();
    await expect(agent).toHaveValue('codex'); await expect(page.locator('#config-native-model')).toHaveValue('model');
    await expect(page.locator(`#config-project-${projectId}-agent`)).toHaveValue('inherit');
    await agent.selectOption('claude');
    await page.getByRole('button', { name: scenario.locale === 'en' ? 'Save configuration' : '保存配置' }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(agent).toBeEnabled();
    state.release(); await expect(agent).toBeEnabled(); await expect(agent).toHaveValue('claude');
  });
}

test('forced colors retains a visible inset arrow', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' }); await install(page);
  await page.goto(`/workers/${target}`); await page.locator('[data-worker-tab="configuration"]:visible').click();
  const agent = page.locator('#config-native-agent'); await expect(agent).toBeVisible();
  const bounds = await paintedArrow(page, agent);
  expect(bounds.count).toBeGreaterThan(3); expect(bounds.width - bounds.right).toBeGreaterThanOrEqual(10); expect(bounds.gapCount).toBe(0);
});
