import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId, botWorkerDefaults } from '../helpers/bots';
import type { CreateBotInput } from '../../src/api/bots';

const workerName = '工作站 Workstation '.repeat(8), directory = '/projects/' + '很长的目录-long-directory/'.repeat(8);
async function install(page: Page, options: { nativeDefault?: boolean; hiddenDefault?: boolean } = {}) {
  const personal = { id: botId(100), kind: 'personal', name: null };
  const posts: CreateBotInput[] = [], reads: { worker: string; operation: string; input: Record<string, unknown> }[] = [];
  let unknown = false, noWorker = false, capabilityError = false, paginated = false;
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers(), status) } });
    if (path === '/api/v1/me') return send({ id: BOT_USER, personalTeam: personal, name: 'Creation fixture', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personal.id}`) return send({ ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personal.id, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } });
    if (path === '/api/v1/assistant-tasks') return send({items:[],nextCursor:null,observedAt:BOT_TIME});
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') {
      if (noWorker) return send({ ...botDefaults(), workerId: null, configuration: null, workers: [], reason: 'no_available_worker' });
      const workerId = url.searchParams.get('workerId') ?? botId(20);
      const configuration = { ...botDefaults().configuration, workerId, cwd: url.searchParams.get('cwd') ?? directory, provider: url.searchParams.get('provider') ?? 'codex', model: url.searchParams.get('model') ?? (options.nativeDefault && !url.searchParams.has('reasoningEffort') ? null : 'model-a'), reasoningEffort: url.searchParams.get('reasoningEffort') ?? (options.nativeDefault ? null : 'high'), selection: { schemaVersion: 1, modelSource: url.searchParams.has('model') ? 'explicit' : options.nativeDefault ? 'native' : 'local', reasoningEffortSource: url.searchParams.has('reasoningEffort') ? 'explicit' : options.nativeDefault ? 'native' : 'local' } };
      return send({ ...botDefaults(), workerId, configuration, workers: [20, 21].map(n => ({ ...botWorkerDefaults(n), machine: { id: botId(120 + n), name: n === 20 ? workerName : 'Second Worker' }, configuration: { ...configuration, workerId: botId(n) } })) });
    }
    if (path.endsWith('/readonly/requests')) {
      const body = request.postDataJSON(), worker = path.split('/')[5]!;
      reads.push({ worker, operation: body.operation, input: body.input });
      const envelope = { type: 'result', protocol: 'daynight.worker-readonly.v1', ownerUserId: BOT_USER, workerId: worker, requestId: body.requestId, connectionId: botId(500), capabilityGeneration: botId(501) };
      if (capabilityError) return send({ ...envelope, error: { code: 'unsupported', message: 'Unsupported by controlled Worker' } });
      if (body.operation === 'directory.list') {
        const path = body.input.path;
        if (paginated) return send({ ...envelope, result: { path, parentPath: '/projects', entries: body.input.cursor ? [{ name: 'Second page folder', path: `${path}second` }] : [{ name: 'First page folder', path: `${path}first` }], nextCursor: body.input.cursor ? null : 'page-2' } });
        return send({ ...envelope, result: { path, parentPath: path === directory ? '/projects' : directory, entries: path === directory ? [{ name: '选择我 chosen', path: `${directory}chosen` }] : [], nextCursor: null } });
      }
      return send({ ...envelope, result: { schemaVersion: 1, provider: body.input.provider, cwd: body.input.cwd ?? directory, configurationGeneration: 'a'.repeat(64), catalogGeneration: botId(502), models: [{ id: 'model-a', label: 'Model A', aliases: [], hidden: options.hiddenDefault ?? false, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }, { id: 'model-b', label: 'Model B', aliases: [], hidden: false, reasoningEfforts: [], defaultReasoningEffort: null }], defaults: { model: { value: body.input.model ?? 'model-a', source: body.input.model ? 'explicit' : options.nativeDefault ? 'native' : 'local' }, reasoningEffort: { value: 'high', source: options.nativeDefault ? 'native' : 'local' } }, selectionError: null, nextCursor: null } });
    }
    if (path === '/api/v1/me/bots' && request.method() === 'POST') {
      const body = request.postDataJSON(); posts.push(body);
      if (unknown) return route.abort('failed');
      return send({ error: { code: 'resource_conflict', message: 'Controlled rejection', requestId: 'creation-fixture' } }, 409);
    }
    if (path === '/api/v1/me/bots') return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'creation-fixture' } }, 404);
  });
  return { posts, reads, paginate: () => { paginated = true; }, unknown: () => { unknown = true; }, noWorker: () => { noWorker = true; }, capabilityError: () => { capabilityError = true; } };
}
const open = async (page: Page) => { await page.locator('.bot-create').click(); await expect(page.locator('#bot-name')).toBeFocused(); await expect(page.locator('.bot-create-actions .primary')).toBeEnabled(); };
async function geometry(page: Page) {
  return page.locator('dialog.bot-create-dialog').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect(), footer = dialog.querySelector('.bot-create-actions')!.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect.toJSON(), footer: footer.toJSON(), scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, documentWidth: document.documentElement.scrollWidth };
  });
}
async function bounded(page: Page) {
  const g = await geometry(page);
  expect(g.dialog.left).toBeGreaterThanOrEqual(11); expect(g.dialog.right).toBeLessThanOrEqual(g.viewport.width - 11);
  expect(g.dialog.top).toBeGreaterThanOrEqual(0); expect(g.dialog.bottom).toBeLessThanOrEqual(g.viewport.height + 1);
  expect(g.footer.bottom).toBeLessThanOrEqual(g.viewport.height); expect(g.scrollWidth).toBeLessThanOrEqual(g.clientWidth + 1);
  expect(g.documentWidth).toBeLessThanOrEqual(g.viewport.width);
  return g;
}
for (const locale of ['en', 'zh-CN']) for (const viewport of [{ width: 1440, height: 1000 }, { width: 960, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 390, height: 300 }]) {
  test(`creation dialog ${locale} ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await install(page); await page.goto('/bots'); await page.locator('.locale-control select').selectOption(locale);
    await open(page); await page.locator('#bot-name').fill('保留 Draft');
    const initial = await bounded(page);
    await page.screenshot({ path: info.outputPath('default.png') });
    expect(fixture.reads).toEqual([]);
    await page.locator('.bot-create-advanced > summary').click();
    await expect(page.locator('#bot-model')).toBeEnabled();
    for (const id of ['worker', 'agent', 'model', 'effort']) {
      const control = page.locator(`#bot-${id}`);
      const measured = await control.evaluate(node => {
        const bounds = node.getBoundingClientRect(), field = node.closest('.field')!.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right, fieldLeft: field.left, fieldRight: field.right, fontSize: parseFloat(getComputedStyle(node).fontSize) };
      });
      expect(measured.width).toBeGreaterThan(0);
      expect(measured.left).toBeGreaterThanOrEqual(measured.fieldLeft - 1);
      expect(measured.right).toBeLessThanOrEqual(measured.fieldRight + 1);
      if (viewport.width <= 800) { expect(measured.height).toBeGreaterThanOrEqual(44); expect(measured.fontSize).toBeGreaterThanOrEqual(16); }
    }
    await expect(page.locator('#bot-worker option').first()).toContainText(workerName);
    const expanded = await bounded(page);
    await page.screenshot({ path: info.outputPath('expanded.png') });
    await page.locator('#bot-cwd').scrollIntoViewIfNeeded();
    if (viewport.width <= 390) {
      expect(await page.locator('#bot-cwd').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
      expect((await page.locator('#bot-cwd').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: /^(Browse|浏览)$/ }).click();
    await expect(page.locator('.bot-directory-entry')).toBeVisible();
    const browsing = await bounded(page);
    await page.screenshot({ path: info.outputPath('browse.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^(Browse|浏览)$/ })).toBeFocused();
    await expect(page.locator('#bot-name')).toHaveValue('保留 Draft');
    await expect(page.locator('#bot-worker')).toHaveValue('');
    await page.getByRole('button', { name: /^(Browse|浏览)$/ }).click();
    await page.locator('.bot-directory-entry').click();
    await page.locator('.bot-create-actions .primary').click();
    await expect(page.locator('#bot-worker')).toHaveValue(botId(20));
    await expect(page.locator('#bot-cwd')).toHaveValue(`${directory}chosen`);
    await page.locator('#bot-model').selectOption('model-a');
    await expect(page.locator('#bot-effort')).toBeEnabled();
    await page.locator('#bot-effort').selectOption('low');
    await expect(page.locator('.bot-create-actions .primary')).toBeEnabled();
    await page.locator('.bot-create-actions .primary').click();
    await expect.poll(() => fixture.posts.length).toBe(1);
    expect(fixture.posts[0]).toEqual({ id: expect.any(String), name: '保留 Draft', overrides: { workerId: botId(20), cwd: `${directory}chosen`, model: 'model-a', reasoningEffort: 'low' } });
    expect(fixture.reads.filter(r => r.operation === 'directory.list').every(r => r.worker === botId(20))).toBe(true);
    await expect(page.locator('.bot-create-form [role=alert]')).toBeVisible();
    await bounded(page); await page.screenshot({ path: info.outputPath('creation.png') });
    await writeFile(info.outputPath('geometry.json'), JSON.stringify({ boundary: 'Production app and typed clients with controlled HTTP/Worker responses, no native Provider or physical keyboard.', locale, initial, expanded, browsing, posts: fixture.posts, reads: fixture.reads }, null, 2));
  });
}

test('name-only payload and unknown close/reopen preserve the original request', async ({ page }) => {
  const fixture = await install(page); fixture.unknown(); await page.goto('/bots'); await open(page);
  await page.locator('#bot-name').fill('Only name'); await page.locator('.bot-create-actions .primary').click();
  await expect(page.getByRole('button', { name: 'Check creation', exact: true })).toBeEnabled();
  expect(fixture.posts).toEqual([{ id: expect.any(String), name: 'Only name' }]);
  const id = fixture.posts[0]!.id;
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.bot-create').click();
  await expect(page.getByText(id, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check creation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check creation', exact: true })).toBeEnabled();
  await expect(page.getByText(id, { exact: true })).toBeVisible(); expect(fixture.posts).toHaveLength(1);
});

test('restoring already-default settings and repeating a reset retain name-only creation', async ({ page }) => {
  const fixture = await install(page); await page.goto('/bots'); await open(page);
  await page.locator('.bot-create-advanced > summary').click();
  await page.getByRole('button', { name: 'Restore all defaults' }).click();
  await expect(page.locator('.bot-create-actions .primary')).toBeEnabled();
  await page.locator('#bot-model').selectOption('model-a');
  await expect(page.locator('#bot-worker')).toHaveValue(botId(20));
  await page.getByRole('button', { name: 'Restore all defaults' }).click();
  await expect(page.locator('.bot-create-actions .primary')).toBeEnabled();
  await page.getByRole('button', { name: 'Restore all defaults' }).click();
  await expect(page.locator('.bot-create-actions .primary')).toBeEnabled();
  await page.locator('#bot-name').fill('Reset defaults');
  await page.locator('.bot-create-actions .primary').click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts).toEqual([{ id: expect.any(String), name: 'Reset defaults' }]);
});

test('no Worker keeps the name editable and prevents submission', async ({ page }) => {
  const fixture = await install(page); fixture.noWorker(); await page.goto('/bots'); await page.locator('.bot-create').click();
  await expect(page.getByRole('alert')).toContainText('No available Worker');
  await expect(page.locator('#bot-name')).toBeEditable(); await expect(page.locator('.bot-create-actions .primary')).toBeDisabled();
});

test('unsupported model and directory errors preserve the draft and permit name-only creation', async ({ page }) => {
  const fixture = await install(page); fixture.capabilityError(); await page.goto('/bots'); await open(page);
  await page.locator('#bot-name').fill('Retained draft'); await page.locator('.bot-create-advanced > summary').click();
  await expect(page.locator('.bot-create-capabilities [role=alert]')).toContainText('unsupported');
  await expect(page.locator('#bot-model')).toBeDisabled();
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await expect(page.locator('.bot-directory-browser [role=alert]')).toBeVisible();
  await expect(page.locator('.bot-create-actions .primary')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Browse', exact: true })).toBeFocused();
  await expect(page.locator('#bot-name')).toHaveValue('Retained draft');
  await page.locator('.bot-create-actions .primary').click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]).toEqual({ id: expect.any(String), name: 'Retained draft' });
});


test('directory permission recovery retains loaded pages, edited path and focused filter', async ({ page }) => {
  const fixture = await install(page); fixture.paginate(); await page.goto('/bots'); await open(page);
  await page.locator('.bot-create-advanced > summary').click();
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await page.getByRole('button', { name: 'Load more folders' }).click();
  const second = page.getByRole('button', { name: /Second page folder/ });
  await expect(second).toBeVisible(); const node = await second.elementHandle();
  await page.getByRole('textbox', { name: 'Browse path' }).fill('/draft/not-navigated');
  const filter = page.getByRole('searchbox', { name: 'Filter loaded folders' }); await filter.focus();
  const before = fixture.reads.filter(r => r.operation === 'directory.list').length;
  await page.evaluate(async () => {
    const path = '/src/api/client.ts'; const client = await import(path);
    const resume = client.pauseAuthRequests(); setTimeout(resume, 250);
  });
  await expect.poll(() => fixture.reads.filter(r => r.operation === 'directory.list').length).toBe(before + 2);
  await expect(second).toBeVisible(); expect(await second.evaluate((current, old) => current === old, node)).toBe(true);
  await expect(filter).toBeFocused(); await expect(page.getByRole('textbox', { name: 'Browse path' })).toHaveValue('/draft/not-navigated');
  expect(fixture.posts).toHaveLength(0);
});

test('cancelling the native model menu keeps the dialog and restores model focus', async ({ page }) => {
  const fixture = await install(page); await page.goto('/bots'); await open(page);
  await page.locator('#bot-name').fill('Draft survives native cancellation');
  await page.locator('.bot-create-advanced > summary').click();
  const model = page.locator('#bot-model'); await expect(model).toBeEnabled(); await model.focus();
  await model.click();
  await expect.poll(() => model.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.bot-create-dialog')).toBeVisible(); await expect(model).toBeFocused();
  await expect(model).toHaveValue(''); await expect(page.locator('#bot-name')).toHaveValue('Draft survives native cancellation'); expect(fixture.posts).toHaveLength(0);
});

test.describe('coarse pointer at desktop width', () => {
  test.use({ viewport: { width: 960, height: 720 }, hasTouch: true, isMobile: true });
  test('Bot selectors use touch sizing independently of viewport width', async ({ page }) => {
    await install(page); await page.goto('/bots'); await open(page);
    await expect.poll(() => page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.locator('.bot-create-advanced > summary').click(); await expect(page.locator('#bot-model')).toBeEnabled();
    for (const id of ['worker', 'agent', 'model', 'effort']) {
      const dimensions = await page.locator(`#bot-${id}`).evaluate(node => ({ height: node.getBoundingClientRect().height, font: parseFloat(getComputedStyle(node).fontSize) }));
      expect(dimensions.height).toBeGreaterThanOrEqual(44); expect(dimensions.font).toBeGreaterThanOrEqual(16);
    }
    await bounded(page);
  });
});


for (const hiddenDefault of [false, true]) test(`native default permits effort-only creation with hidden model ${hiddenDefault}`, async ({ page }, info) => {
  const fixture = await install(page, { nativeDefault: true, hiddenDefault });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/bots'); await open(page);
  await page.locator('#bot-name').fill('Native effort only');
  await page.locator('.bot-create-advanced > summary').click();
  await expect(page.locator('#bot-effort')).toBeEnabled();
  await expect(page.locator('#bot-model')).toHaveValue('');
  await expect(page.locator('#bot-model option:checked')).toContainText('model-a');
  await expect(page.locator('#bot-effort option:checked')).toContainText('high');
  if (hiddenDefault) await expect(page.getByRole('option', { name: 'Model A', exact: true })).toHaveCount(0);
  expect(fixture.reads.filter(read => read.operation === 'model.list').every(read => read.input.includeHidden === true)).toBe(true);
  await page.locator('#bot-effort').selectOption('low');
  await expect(page.locator('#bot-worker')).toHaveValue(botId(20));
  await expect(page.locator('.bot-create-actions .primary')).toBeEnabled();
  await page.locator('#bot-effort').scrollIntoViewIfNeeded();
  const measured = await bounded(page);
  await page.screenshot({ path: info.outputPath('native-effort-only.png') });
  await page.locator('.bot-create-actions .primary').click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]).toEqual({ id: expect.any(String), name: 'Native effort only', overrides: { workerId: botId(20), reasoningEffort: 'low' } });
  await writeFile(info.outputPath('native-effort-only.json'), JSON.stringify({ boundary: 'Production app and typed clients with controlled HTTP/Worker responses.', hiddenDefault, geometry: measured, posts: fixture.posts, reads: fixture.reads }, null, 2));
});
