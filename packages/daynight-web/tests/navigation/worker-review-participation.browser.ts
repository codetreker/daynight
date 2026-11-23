import { expect, test, type Page } from '@playwright/test';
import { configurationResource } from '../helpers/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId, workerPage, workerSummary } from '../helpers/workers';

const first = workerId(1), second = workerId(2), personalId = workerId(90);
const personal = { id: personalId, kind: 'personal', name: null };
type Setting = { enabled: boolean; version: string };
type Gate = ReturnType<typeof gate>;
const gate = () => {
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  return { started: started.promise, notify: started.resolve, wait: finish.promise, finish: finish.resolve };
};

const install = async (page: Page, locale: 'zh-CN' | 'en' = 'zh-CN') => {
  const state = {
    settings: new Map<string, Setting>([[first, { enabled: true, version: '9007199254740993' }], [second, { enabled: false, version: '1' }]]),
    writes: [] as { worker: string; body: { enabled: boolean; expectedVersion: string } }[],
    reads: [] as string[], otherWrites: [] as string[], readFailure: false, readMissing: false, missing: false,
    configFailure: false, uninitialized: false, mode: 'normal' as 'normal' | 'reject' | 'conflict' | 'lost',
    putGate: null as Gate | null, getGate: null as Gate | null, actor: WORKER_USER,
  };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, actor = state.actor;
    const send = (json: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, json, headers: { 'Daynight-User-ID': actor, ...extra } });
    const error = (status: number, code: string) => send({ error: { code, message: 'Fixture error', requestId: 'fixture' } }, status);
    if (path === '/api/v1/me') return send({ id: actor, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: actor, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/workers/monitoring/query') return send({ observedAt: WORKER_TIME, items: [] });
    if (path === '/api/v1/me/workers') return send(workerPage([workerSummary(1), { ...workerSummary(2), lastReportedAt: '2026-10-29T11:50:00Z' }]));
    const match = path.match(/^\/api\/v1\/me\/workers\/([^/]+)(?:\/(.*))?$/);
    if (match && (match[1] === first || match[1] === second)) {
      const worker = match[1], resource = match[2];
      if (resource === undefined) {
        const detail = workerDetail(worker === first ? 1 : 2);
        if (worker === second) detail.worker.lastReportedAt = '2026-10-29T11:50:00Z';
        return send(detail, 200, { 'Daynight-Worker-Tool-Paths': '2' });
      }
      if (resource === 'configuration') {
        if (request.method() !== 'GET') state.otherWrites.push(`${request.method()} ${path}`);
        if (state.configFailure) return error(500, 'internal_error');
        return send(state.uninitialized ? { ...configurationResource(), desired: null } : configurationResource(), 200, { 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' });
      }
      if (resource === 'prompt') {
        if (request.method() !== 'GET') state.otherWrites.push(`${request.method()} ${path}`);
        return send({ scope: 'worker', scopeId: worker, revision: '1', text: 'Original prompt', updatedAt: WORKER_TIME });
      }
      if (resource === 'review-participation') {
        if (state.missing) return error(404, 'not_found');
        if (request.method() === 'GET') {
          state.reads.push(worker);
          if (state.readMissing) return error(404, 'not_found');
          if (state.readFailure) return error(500, 'internal_error');
          const value = state.settings.get(worker), currentGate = state.getGate; state.getGate = null;
          if (currentGate) { currentGate.notify(); await currentGate.wait; }
          return send(value);
        }
        const body = request.postDataJSON() as { enabled: boolean; expectedVersion: string };
        state.writes.push({ worker, body });
        const currentGate = state.putGate; state.putGate = null;
        if (currentGate) { currentGate.notify(); await currentGate.wait; }
        if (state.mode === 'reject') return error(400, 'invalid_input');
        if (state.mode === 'conflict') return error(409, 'version_conflict');
        const next = { enabled: body.enabled, version: String(BigInt(body.expectedVersion) + 1n) };
        state.settings.set(worker, next);
        if (state.mode === 'lost') return route.abort('failed');
        return send(next);
      }
    }
    if (request.method() !== 'GET') state.otherWrites.push(`${request.method()} ${path}`);
    return error(404, 'not_found');
  });
  return state;
};

const open = async (page: Page, worker = second) => {
  await page.goto(`/workers/${worker}`);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
};
const toggle = (page: Page, locale: 'zh-CN' | 'en' = 'zh-CN') => page.getByRole('switch', { name: locale === 'zh-CN' ? '参与 PR 审查' : 'Participate in PR review' });

for (const locale of ['zh-CN', 'en'] as const) for (const width of [1360, 320]) {
  test(`${locale} ${width}px shows the review card between saved response and runtime settings`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, locale); await open(page);
    const control = toggle(page, locale), source = page.locator('.configuration-source');
    const card = page.getByRole('heading', { name: locale === 'zh-CN' ? 'PR 审查' : 'PR review', exact: true });
    const runtime = page.getByRole('heading', { name: locale === 'zh-CN' ? '运行设置' : 'Runtime settings', exact: true });
    await expect(control).toHaveAttribute('aria-disabled', 'false'); await expect(control).toHaveAttribute('aria-checked', 'false');
    const order = async () => {
      const positions = await Promise.all([source.boundingBox(), card.boundingBox(), runtime.boundingBox()]);
      expect(positions[0]!.y + positions[0]!.height).toBeLessThan(positions[1]!.y);
      expect(positions[1]!.y).toBeLessThan(positions[2]!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    };
    await order(); await source.locator('summary').click(); await order();
    await page.locator('#config-maxConcurrent').fill('7');
    const pending = gate(); state.putGate = pending;
    await control.focus(); await page.keyboard.press('Space'); await pending.started;
    try { await expect(control).toHaveAttribute('aria-checked', 'false'); await expect(control).toHaveAttribute('aria-disabled', 'true'); await expect(control).toBeFocused(); await page.keyboard.press('Space'); expect(state.writes).toHaveLength(1); } finally { pending.finish(); }
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#config-maxConcurrent')).toHaveValue('7');
    expect(state.writes).toEqual([{ worker: second, body: { enabled: true, expectedVersion: '1' } }]);
    expect(state.otherWrites).toEqual([]);
  });
}

test('offline Worker saves independently and refreshes without changing another Worker', async ({ page }) => {
  const state = await install(page); await open(page, first);
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await open(page, second); await expect(page.getByText('离线', { exact: true }).first()).toBeVisible(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await page.reload(); await page.locator('[data-worker-tab="configuration"]:visible').click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  await page.reload(); await page.locator('[data-worker-tab="configuration"]:visible').click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  await open(page, first); await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  expect(state.writes).toEqual([{ worker: second, body: { enabled: true, expectedVersion: '1' } }, { worker: second, body: { enabled: false, expectedVersion: '2' } }]);
});

test('independent loading recovers, and uninitialized or failed configuration does not block the switch', async ({ page }) => {
  const state = await install(page); state.readFailure = true; state.uninitialized = true; await open(page);
  await expect(page.getByText('读取 PR 审查设置失败。')).toBeVisible();
  state.readFailure = false;
  await page.getByText('读取 PR 审查设置失败。').locator('..').getByRole('button', { name: '重试' }).click();
  await expect(toggle(page)).toHaveAttribute('aria-disabled', 'false'); await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  state.configFailure = true; await page.reload(); await page.locator('[data-worker-tab="configuration"]:visible').click();
  await expect(page.getByText('读取配置失败。')).toBeVisible(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
});

test('unsupported service leaves the remaining configuration available', async ({ page }) => {
  const state = await install(page); state.missing = true; await open(page);
  await expect(page.getByText('PR 审查设置不可用。')).toBeVisible();
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('2'); expect(state.writes).toEqual([]);
});

test('switch saves without submitting or discarding configuration and prompt drafts', async ({ page }) => {
  const state = await install(page); await open(page);
  await page.locator('#config-maxConcurrent').fill('7');
  await page.locator('[data-worker-tab="prompt"]:visible').click();
  const prompt = page.locator('.worker-prompt-text'); await expect(prompt).toHaveValue('Original prompt');
  await prompt.fill('Unsubmitted prompt');
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('7');
  await page.locator('[data-worker-tab="prompt"]:visible').click(); await expect(prompt).toHaveValue('Unsubmitted prompt');
  expect(state.writes).toEqual([{ worker: second, body: { enabled: true, expectedVersion: '1' } }]);
  expect(state.otherWrites).toEqual([]);
});

test('late save for one Worker never changes the other Worker', async ({ page }) => {
  const state = await install(page); state.settings.set(first, { enabled: false, version: '4' }); await open(page, second);
  const pending = gate(); state.putGate = pending;
  await toggle(page).click(); await pending.started;
  try {
    await page.locator('a.worker-back-link').click();
    await page.locator(`a.worker-card[href="/workers/${first}"]`).click();
    await page.locator('[data-worker-tab="configuration"]:visible').click();
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  } finally { pending.finish(); }
  await expect.poll(() => state.settings.get(second)?.enabled).toBe(true);
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  expect(state.writes).toEqual([{ worker: second, body: { enabled: true, expectedVersion: '1' } }]);
});

test('explicit rejection, conflict and lost receipt never replay a write', async ({ page }) => {
  const state = await install(page); await open(page); const control = toggle(page);
  await expect(control).toHaveAttribute('aria-disabled', 'false'); state.mode = 'reject'; await control.click();
  await expect(page.getByText('保存 PR 审查设置失败。')).toBeVisible(); await expect(control).toHaveAttribute('aria-checked', 'false');
  state.mode = 'conflict'; state.settings.set(second, { enabled: true, version: '9007199254740993' });
  await control.click(); await expect(page.getByText('设置已被其他位置修改，请核对当前值后再操作。')).toBeVisible();
  await expect(control).toHaveAttribute('aria-checked', 'true');
  state.mode = 'lost'; await control.click();
  await expect(page.getByText('保存结果未知。当前值不能确认原保存是否成功。')).toBeVisible();
  await expect(control).toHaveAttribute('aria-checked', 'false');
  expect(state.writes).toEqual([
    { worker: second, body: { enabled: true, expectedVersion: '1' } },
    { worker: second, body: { enabled: true, expectedVersion: '1' } },
    { worker: second, body: { enabled: false, expectedVersion: '9007199254740993' } },
  ]);
  expect(state.reads.filter(worker => worker === second).length).toBeGreaterThanOrEqual(3);
});

test('a failed check after an unknown save prevents another write until a successful read', async ({ page }) => {
  const state = await install(page); await open(page); const control = toggle(page);
  await expect(control).toHaveAttribute('aria-disabled', 'false');
  state.mode = 'lost'; state.readFailure = true;
  await control.click();
  await expect(page.getByText('无法核对当前值。')).toBeVisible();
  await expect(control).toHaveAttribute('aria-disabled', 'true');
  await control.focus(); await page.keyboard.press('Space'); expect(state.writes).toHaveLength(1);
  state.readFailure = false;
  await page.getByText('无法核对当前值。').locator('..').getByRole('button', { name: '重试' }).click();
  await expect(control).toHaveAttribute('aria-checked', 'true');
  await expect(control).toHaveAttribute('aria-disabled', 'false');
  await expect(page.getByText('保存结果未知。当前值不能确认原保存是否成功。')).toBeVisible();
  expect(state.writes).toEqual([{ worker: second, body: { enabled: true, expectedVersion: '1' } }]);
});

test('a 404 while checking an unknown save can be retried without replaying the write', async ({ page }) => {
  const state = await install(page); await open(page); const control = toggle(page);
  await expect(control).toHaveAttribute('aria-disabled', 'false');
  state.mode = 'lost'; state.readMissing = true;
  await control.click();
  await expect(page.getByText('无法核对当前值。')).toBeVisible();
  await expect(control).toHaveAttribute('aria-disabled', 'true');
  state.readMissing = false;
  await page.getByText('无法核对当前值。').locator('..').getByRole('button', { name: '重试' }).click();
  await expect(control).toHaveAttribute('aria-checked', 'true');
  await expect(control).toHaveAttribute('aria-disabled', 'false');
  await expect(page.getByText('保存结果未知。当前值不能确认原保存是否成功。')).toBeVisible();
  expect(state.writes).toEqual([{ worker: second, body: { enabled: true, expectedVersion: '1' } }]);
});

test('a late read from the previous account cannot become the new account setting', async ({ page, context }) => {
  const state = await install(page); const oldRead = gate(); state.getGate = oldRead;
  await open(page); await oldRead.started;
  const other = await context.newPage();
  try {
    await other.route('**/api/v1/**', route => route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } } }));
    await other.goto('/');
    state.actor = workerId(88); state.settings.set(second, { enabled: true, version: '8' });
    await other.evaluate(user => localStorage.setItem('daynight.activeUser', JSON.stringify(user)), state.actor);
    await expect(page.getByText('账户已变化', { exact: true })).toBeVisible();
    oldRead.finish();
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: '刷新页面' }).click()]);
    await page.locator('[data-worker-tab="configuration"]:visible').click();
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page)).toHaveAttribute('aria-disabled', 'false');
    expect(state.writes).toEqual([]);
  } finally { oldRead.finish(); await other.close(); }
});
