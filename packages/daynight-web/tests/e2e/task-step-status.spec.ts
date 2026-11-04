import type { Locator, Page, TestInfo } from '@playwright/test';
import { decodeMembersJson, parseMembers } from '../../src/api/auth-parse';
import { parseApiJson, stringifyApiJson } from '../../src/api/json';
import { parseTaskSteps, type StepStatus, type StepsResource } from '../../src/api/task-steps';
import { authenticatedAPI, bearerContext, browserAuthentication, fulfillAuthenticatedResponse, type AuthenticatedAPI } from './authentication';
import { createProject, createTask, expect, test, updateTask } from './fixtures';
import { selectTaskList } from './project-view';

const labels: Record<StepStatus, string> = { todo: '待开始', in_progress: '进行中', done: '已完成', skipped: '已跳过' };
const stepIdForDeleted = (): string => '1234abcf';
const root = (page: Page): Locator => page.locator('.task-detail-page, .task-detail-dialog');
const row = (page: Page, id: string): Locator => root(page).locator(`.step-row[data-step-id="${id}"]`);
const trigger = (page: Page, id: string): Locator => row(page, id).locator('button.step-status');
const endpoint = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}/steps`;
const read = async (api: AuthenticatedAPI, project: string, task: string): Promise<StepsResource> => {
  const response = await api.get(endpoint(project, task));
  expect(response.status()).toBe(200);
  return parseTaskSteps(parseApiJson(await response.text()), project, task);
};
const choose = async (page: Page, id: string, status: StepStatus): Promise<void> => {
  await expect(trigger(page, id)).toBeEnabled();
  await trigger(page, id).click();
  const option = page.getByRole('menuitemradio', { name: labels[status], exact: true });
  await expect(option).toBeVisible();
  await option.click();
};
const screenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};

test('step status writes converge through real service resources', { annotation: { type: 'scenario', description: 'task-step-status' } }, async ({ page, api, baseURL, allowBrowserWrites }, info) => {
  const project = await createProject(api, { name: 'Step status browser acceptance' });
  const task = await createTask(api, project.id, { title: 'Steps status acceptance' });
  const other = await createTask(api, project.id, { title: 'Other task while waiting' });
  const deletedTask = await createTask(api, project.id, { title: 'Deleted parent acceptance' });
  const raceTask = await createTask(api, project.id, { title: 'Step reconciliation version advance' });
  const reopenTask = await createTask(api, project.id, { title: 'Step reconciliation reopening' });
  const reopenStepsPath = endpoint(project.id, reopenTask.id);
  const reopenStepId = '5678abcd';
  const reopenInitial = await api.post(reopenStepsPath, { data: { version: reopenTask.version, id: reopenStepId, title: 'Reopening step' } });
  expect(reopenInitial.status()).toBe(201);
  const raceStepsPath = endpoint(project.id, raceTask.id);
  const raceStepId = '4567abcd';
  const raceInitial = await api.post(raceStepsPath, { data: { version: raceTask.version, id: raceStepId, title: 'Version advance step' } });
  expect(raceInitial.status()).toBe(201);
  const deletedPath = endpoint(project.id, deletedTask.id);
  const deletedStep = await api.post(deletedPath, { data: { version: deletedTask.version, id: stepIdForDeleted(), title: 'Deleted parent step' } });
  expect(deletedStep.status()).toBe(201);
  const stepsPath = endpoint(project.id, task.id);
  const stepId = '1234abcd';
  const otherId = '1234abce';
  const first = await api.post(stepsPath, { data: { version: task.version, id: stepId, title: '浏览器步骤', description: 'Retained description.' } });
  expect(first.status()).toBe(201);
  const firstSteps = parseTaskSteps(parseApiJson(await first.text()), project.id, task.id);
  const second = await api.post(stepsPath, { data: { version: Number(firstSteps.version), id: otherId, title: '另一个步骤' } });
  expect(second.status()).toBe(201);
  const before = parseTaskSteps(parseApiJson(await second.text()), project.id, task.id);
  const statusUrl = new URL(`${stepsPath}/${stepId}/status`, baseURL).href;
  const deletedUrl = new URL(`${deletedPath}/${stepIdForDeleted()}/status`, baseURL).href;
  const collectionUrl = new URL(stepsPath, baseURL).href;
  const raceCollectionUrl = new URL(raceStepsPath, baseURL).href;
  const raceParentUrl = new URL(`/api/v1/projects/${project.id}/tasks/${raceTask.id}`, baseURL).href;
  const raceStatusUrl = new URL(`${raceStepsPath}/${raceStepId}/status`, baseURL).href;
  const reopenCollectionUrl = new URL(reopenStepsPath, baseURL).href;
  const reopenParentUrl = new URL(`/api/v1/projects/${project.id}/tasks/${reopenTask.id}`, baseURL).href;
  const reopenStatusUrl = new URL(`${reopenStepsPath}/${reopenStepId}/status`, baseURL).href;
  allowBrowserWrites([{ method: 'PUT', url: statusUrl, count: 11 }, { method: 'PUT', url: deletedUrl, count: 1 }, { method: 'PUT', url: raceStatusUrl, count: 1 }, { method: 'PUT', url: reopenStatusUrl, count: 1 }]);
  let writes = 0;
  let mode: 'normal' | 'conflict' | 'lost' | 'invalid' | 'child404' | 'late' = 'normal';
  let releaseLate!: () => void;
  let enteredLate!: () => void;
  const late = new Promise<void>(resolve => { releaseLate = resolve; });
  const lateEntered = new Promise<void>(resolve => { enteredLate = resolve; });
  let rejectReads = false;
  const recoveryIds: string[] = [];
  page.on('request', request => {
    if (request.method() === 'GET' && request.url() === collectionUrl) {
      const id = request.headers()['x-request-id'];
      if (id !== undefined) recoveryIds.push(id);
    }
  });
  const receipts: { status: number; body: string; requestId: string | null }[] = [];
  await page.route(collectionUrl, async route => {
    if (rejectReads && route.request().method() === 'GET') await route.abort('connectionfailed');
    else await route.continue();
  });
  await page.route(statusUrl, async route => {
    writes += 1;
    if (mode === 'conflict') {
      mode = 'normal';
      const current = await (await api.get(`/api/v1/projects/${project.id}/tasks/${task.id}`)).json();
      await updateTask(api, project.id, task.id, { version: current.version, description: 'A concurrent task update.' });
    }
    const response = mode === 'child404'
      ? await api.put(`${stepsPath}/deadbeef/status`, { data: route.request().postDataJSON() })
      : await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
    const body = await response.text();
    receipts.push({ status: response.status(), body, requestId: route.request().headers()['x-request-id'] ?? null });
    if (mode === 'lost') { mode = 'normal'; rejectReads = true; await route.abort('connectionfailed'); return; }
    if (mode === 'invalid') { mode = 'normal'; rejectReads = true; await route.fulfill({ status: 200, headers: { ...response.headers(), 'content-length': '2' }, body: '{}' }); return; }
    if (mode === 'child404') mode = 'normal';
    if (mode === 'late') { mode = 'normal'; enteredLate(); await late; }
    await fulfillAuthenticatedResponse(route, response);
  });
  try {
    await page.goto(`/projects/${project.id}/tasks/${task.id}?tab=steps`);
    await expect(row(page, stepId)).toBeVisible();
    await expect(trigger(page, stepId)).toContainText(labels.todo);
    for (const status of ['in_progress', 'done', 'skipped', 'todo'] as const) {
      await choose(page, stepId, status);
      await expect(trigger(page, stepId)).toContainText(labels[status]);
      await expect(trigger(page, stepId)).toBeEnabled();
      expect((await read(api, project.id, task.id)).steps.find(step => step.id === stepId)?.status).toBe(status);
    }
    const completed = await read(api, project.id, task.id);
    expect(completed.version).toBe(before.version + 4n);
    expect(completed.steps[1]).toEqual(before.steps[1]);
    mode = 'conflict';
    await choose(page, stepId, 'done');
    await expect(root(page).getByRole('alert').first()).toBeVisible();
    await expect(trigger(page, stepId)).toContainText(labels.todo);
    expect(receipts[4]?.status).toBe(409);
    await expect(trigger(page, stepId)).toBeEnabled();
    await choose(page, stepId, 'done');
    await expect(trigger(page, stepId)).toContainText(labels.done);
    await expect(trigger(page, stepId)).toBeEnabled();
    mode = 'lost';
    await choose(page, stepId, 'in_progress');
    const retry = root(page).getByRole('button', { name: '读取当前步骤', exact: true });
    await expect(retry).toBeEnabled();
    await expect(trigger(page, stepId)).toBeDisabled();
    expect((await read(api, project.id, task.id)).steps[0]?.status).toBe('in_progress');
    expect(writes).toBe(7);
    rejectReads = false;
    await retry.click();
    await expect(trigger(page, stepId)).toContainText(labels.in_progress);
    await expect(trigger(page, stepId)).toBeEnabled();
    expect(writes).toBe(7);
    expect(receipts[6]?.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(recoveryIds.some(id => id.startsWith(`${receipts[6]!.requestId}.r`))).toBe(true);
    mode = 'invalid';
    await choose(page, stepId, 'skipped');
    await expect(retry).toBeEnabled();
    await expect(trigger(page, stepId)).toBeDisabled();
    await expect(trigger(page, stepId)).toContainText(labels.in_progress);
    rejectReads = false;
    await retry.click();
    await expect(trigger(page, stepId)).toContainText(labels.skipped);
    await expect(trigger(page, stepId)).toBeEnabled();
    expect(writes).toBe(8);
    expect(receipts.every(receipt => receipt.requestId !== null)).toBe(true);
    mode = 'child404';
    await choose(page, stepId, 'done');
    await expect(root(page).getByRole('alert').first()).toBeVisible();
    expect(receipts[8]?.status).toBe(404);
    await expect(trigger(page, stepId)).toContainText(labels.skipped);
    await expect(trigger(page, stepId)).toBeEnabled();
    await expect(row(page, otherId)).toBeVisible();
    for (const locale of ['zh-CN', 'en']) {
      await root(page).getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await trigger(page, stepId).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('menuitemradio')).toHaveCount(4);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await screenshot(page, info, `step-status-${locale}-${width}`);
        await page.keyboard.press('Escape');
        await expect(trigger(page, stepId)).toBeFocused();
      }
    }
    await root(page).getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
    await page.goto(`/projects/${project.id}`);
    await selectTaskList(page);
    await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    await page.locator(`#standalone-task-${task.id}`).click();
    await root(page).getByRole('tab', { name: '步骤', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 240 });
    await trigger(page, stepId).scrollIntoViewIfNeeded();
    await trigger(page, stepId).focus();
    await page.keyboard.press('Enter');
    const options = page.getByRole('menuitemradio');
    await expect(options).toHaveCount(4);
    for (const option of await options.all()) {
      await expect(option).toBeVisible();
      const box = await option.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(240);
    }
    await screenshot(page, info, 'step-status-dialog-320-short');
    await page.keyboard.press('Escape');
    await expect(trigger(page, stepId)).toBeFocused();
    await page.setViewportSize({ width: 320, height: 390 });
    await trigger(page, stepId).scrollIntoViewIfNeeded();
    await trigger(page, stepId).click();
    const shortMenu = page.getByRole('menu', { name: '浏览器步骤的状态', exact: true });
    await expect(shortMenu).toBeVisible();
    const geometryBefore = await shortMenu.boundingBox();
    await root(page).locator('.task-detail-panel-steps').evaluate(element => { element.scrollTop += 30; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))));
    const geometryAfter = await shortMenu.boundingBox();
    expect(geometryBefore).not.toBeNull(); expect(geometryAfter).not.toBeNull();
    expect(geometryAfter!.x).toBeGreaterThanOrEqual(0);
    expect(geometryAfter!.x + geometryAfter!.width).toBeLessThanOrEqual(320);
    expect(geometryAfter!.y).toBeGreaterThanOrEqual(0);
    expect(geometryAfter!.y + geometryAfter!.height).toBeLessThanOrEqual(390);
    await info.attach('step-status-menu-geometry', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ before: geometryBefore, after: geometryAfter })) });
    await screenshot(page, info, 'step-status-dialog-320-scroll');
    const beforeNoop = await read(api, project.id, task.id);
    await page.getByRole('menuitemradio', { name: labels.skipped, exact: true }).click();
    await expect(trigger(page, stepId)).toBeEnabled();
    expect(await read(api, project.id, task.id)).toEqual(beforeNoop);
    await page.setViewportSize({ width: 1440, height: 800 });
    mode = 'late';
    await choose(page, stepId, 'done');
    await lateEntered;
    await expect(trigger(page, stepId)).toContainText(labels.skipped);
    await root(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await page.locator(`#standalone-task-${other.id}`).click();
    releaseLate();
    await expect(root(page).locator('.task-detail-title')).toContainText(other.title);
    await root(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await page.locator(`#standalone-task-${task.id}`).click();
    await root(page).getByRole('tab', { name: '步骤', exact: true }).click();
    await expect(trigger(page, stepId)).toContainText(labels.done);
    await expect(trigger(page, stepId)).toBeEnabled();
    expect(writes).toBe(11);
    await root(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    const frozenTime = new Date('2030-01-01T00:00:00Z');
    await page.clock.install({ time: frozenTime }); await page.clock.pauseAt(frozenTime);
    await page.goto(`/projects/${project.id}`);
    await selectTaskList(page);
    await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    await page.locator(`#standalone-task-${reopenTask.id}`).click();
    await root(page).getByRole('tab', { name: '步骤', exact: true }).click();
    await expect(trigger(page, reopenStepId)).toBeEnabled();
    const reopenUpdatedAt = root(page).locator('.task-detail-metadata > div:nth-child(2) time');
    const reopenInitialUpdatedAt = await reopenUpdatedAt.getAttribute('datetime');
    expect(reopenInitialUpdatedAt).not.toBeNull();
    let releaseReopenSteps!: () => void; let reopenStepsEntered!: () => void; let reopenStepsDelivered!: () => void;
    let releaseReopenParent!: () => void; let firstReopenParentDelivered!: () => void;
    const reopenStepsGate = new Promise<void>(resolve => { releaseReopenSteps = resolve; });
    const reopenStepsWaiting = new Promise<void>(resolve => { reopenStepsEntered = resolve; });
    const reopenStepsDone = new Promise<void>(resolve => { reopenStepsDelivered = resolve; });
    const reopenParentGate = new Promise<void>(resolve => { releaseReopenParent = resolve; });
    const firstReopenParent = new Promise<void>(resolve => { firstReopenParentDelivered = resolve; });
    let reopenStarted = false; let reopening = false; let reopenReads = 0; let reopenWrites = 0; let reopenParentStarted = false;
    let reopenFirstVersion: bigint | null = null; let reopenFirstUpdatedAt: string | null = null;
    let reopenStepsVersion: bigint | null = null; let reopenedParentVersion: bigint | null = null;
    const reopenEvents: string[] = [];
    await page.route(reopenCollectionUrl, async route => {
      if (!reopenStarted) { await route.continue(); return; }
      reopenEvents.push('steps-held'); reopenStepsEntered(); await reopenStepsGate;
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200);
      reopenStepsVersion = parseTaskSteps(parseApiJson(await response.text()), project.id, reopenTask.id).version;
      await fulfillAuthenticatedResponse(route, response); reopenEvents.push('steps-delivered'); reopenStepsDelivered();
    });
    await page.route(reopenParentUrl, async route => {
      if (!reopenStarted || route.request().method() !== 'GET') { await route.continue(); return; }
      const readNumber = ++reopenReads; const openingRead = reopening;
      if (openingRead) { reopenEvents.push('reopened-parent-held'); reopenParentStarted = true; await reopenParentGate; }
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200);
      const parent = parseApiJson(await response.text()) as { version: bigint; updatedAt: string };
      if (readNumber === 1) { reopenFirstVersion = parent.version; reopenFirstUpdatedAt = parent.updatedAt; }
      if (openingRead) reopenedParentVersion = parent.version;
      await fulfillAuthenticatedResponse(route, response);
      if (readNumber === 1) { reopenEvents.push('first-parent-delivered'); firstReopenParentDelivered(); }
      if (openingRead) reopenEvents.push('reopened-parent-delivered');
    });
    await page.route(reopenStatusUrl, async route => {
      reopenWrites += 1;
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200); reopenStarted = true; reopenEvents.push('write-response-lost'); await route.abort('connectionfailed');
    });
    try {
      await choose(page, reopenStepId, 'done');
      await Promise.all([reopenStepsWaiting, firstReopenParent]);
      expect(reopenFirstUpdatedAt).not.toBeNull(); expect(reopenFirstUpdatedAt).not.toBe(reopenInitialUpdatedAt);
      await expect(reopenUpdatedAt).toHaveAttribute('datetime', reopenFirstUpdatedAt!);
      reopenEvents.push('first-parent-admitted'); expect(reopenReads).toBe(1);
      await expect(trigger(page, reopenStepId)).toBeDisabled();
      await root(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
      await expect(root(page)).toHaveCount(0); reopenEvents.push('dialog-closed');
      reopening = true; reopenEvents.push('reopen-requested');
      await page.locator(`#standalone-task-${reopenTask.id}`).click();
      await root(page).getByRole('tab', { name: '步骤', exact: true }).click(); reopenEvents.push('dialog-reopened');
      await expect(trigger(page, reopenStepId)).toBeDisabled();
      await expect(root(page).locator('.task-status-trigger')).toBeDisabled();
      expect(reopenWrites).toBe(1);
      releaseReopenSteps(); await reopenStepsDone;
      expect(reopenStepsVersion).toBe(reopenFirstVersion);
      await expect.poll(() => reopenParentStarted, { timeout: 15_000 }).toBe(true);
      await expect(trigger(page, reopenStepId)).toBeDisabled();
      await expect(root(page).locator('.task-status-trigger')).toBeDisabled();
      releaseReopenParent();
      await expect(trigger(page, reopenStepId)).toHaveText(/已完成/);
      await expect(trigger(page, reopenStepId)).toBeEnabled();
      await expect(root(page).locator('.task-status-trigger')).toBeEnabled();
      await expect(root(page).getByRole('alert')).toContainText('先前请求的结果仍未知');
      expect(reopenedParentVersion).toBe(reopenFirstVersion); expect(reopenWrites).toBe(1);
      await info.attach('step-reopening-reconciliation', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ events: reopenEvents, version: String(reopenFirstVersion), parentReads: reopenReads, writes: reopenWrites })) });
    } finally {
      releaseReopenSteps(); releaseReopenParent();
      await page.unroute(reopenStatusUrl); await page.unroute(reopenParentUrl); await page.unroute(reopenCollectionUrl);
      await page.clock.resume();
    }
    await page.goto(`/projects/${project.id}/tasks/${raceTask.id}?tab=steps`);
    await expect(trigger(page, raceStepId)).toBeEnabled();
    const parentUpdatedAt = root(page).locator('.task-detail-metadata > div:nth-child(2) time');
    const initialParentUpdatedAt = await parentUpdatedAt.getAttribute('datetime');
    expect(initialParentUpdatedAt).not.toBeNull();
    let releaseRaceSteps!: () => void; let raceStepsEntered!: () => void; let raceStepsDelivered!: () => void;
    let releaseParent!: () => void; let firstParentDelivered!: () => void; let nextParentEntered!: () => void;
    const raceStepsGate = new Promise<void>(resolve => { releaseRaceSteps = resolve; });
    const raceStepsWaiting = new Promise<void>(resolve => { raceStepsEntered = resolve; });
    const raceStepsDone = new Promise<void>(resolve => { raceStepsDelivered = resolve; });
    const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    const firstParent = new Promise<void>(resolve => { firstParentDelivered = resolve; });
    const nextParent = new Promise<void>(resolve => { nextParentEntered = resolve; });
    let raceStarted = false; let parentReads = 0; let raceWrites = 0; let deliveredVersion: bigint | null = null; let firstParentVersion: bigint | null = null; let firstParentUpdatedAt: string | null = null;
    await page.route(raceCollectionUrl, async route => {
      if (!raceStarted) { await route.continue(); return; }
      raceStepsEntered(); await raceStepsGate;
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200);
      deliveredVersion = parseTaskSteps(parseApiJson(await response.text()), project.id, raceTask.id).version;
      await fulfillAuthenticatedResponse(route, response); raceStepsDelivered();
    });
    await page.route(raceParentUrl, async route => {
      if (!raceStarted || route.request().method() !== 'GET') { await route.continue(); return; }
      const readNumber = ++parentReads;
      if (readNumber > 1) { nextParentEntered(); await parentGate; }
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200);
      if (readNumber === 1) {
        const parent = parseApiJson(await response.text()) as { version: bigint; updatedAt: string };
        firstParentVersion = parent.version; firstParentUpdatedAt = parent.updatedAt;
      }
      await fulfillAuthenticatedResponse(route, response);
      if (readNumber === 1) firstParentDelivered();
    });
    await page.route(raceStatusUrl, async route => {
      raceWrites += 1;
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200); raceStarted = true; await route.abort('connectionfailed');
    });
    try {
      await choose(page, raceStepId, 'done');
      await Promise.all([raceStepsWaiting, firstParent]);
      expect(firstParentUpdatedAt).not.toBeNull();
      expect(firstParentUpdatedAt).not.toBe(initialParentUpdatedAt);
      await expect(parentUpdatedAt).toHaveAttribute('datetime', firstParentUpdatedAt!);
      await expect(trigger(page, raceStepId)).toBeDisabled();
      const afterStep = parseApiJson(await (await api.get(`/api/v1/projects/${project.id}/tasks/${raceTask.id}`)).text()) as { version: bigint };
      expect(firstParentVersion).toBe(afterStep.version);
      const expectedVersion = afterStep.version + 1n;
      const advancedSync = page.waitForResponse(async response => {
        if (new URL(response.url()).pathname !== `/api/v1/projects/${project.id}/task-sync` || response.status() !== 200) return false;
        const body = parseApiJson(await response.text()) as { tasks?: { id: string; version: string }[] };
        return body.tasks?.some(item => item.id === raceTask.id && /^[1-9][0-9]*$/.test(item.version) && BigInt(item.version) === expectedVersion) === true;
      }, { timeout: 20_000 });
      const advanceResponse = await api.patch(`/api/v1/projects/${project.id}/tasks/${raceTask.id}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: afterStep.version, description: 'Parent advanced while Steps read was held.' }) });
      expect(advanceResponse.status()).toBe(200);
      const advanced = parseApiJson(await advanceResponse.text()) as { version: bigint };
      expect(advanced.version).toBe(expectedVersion);
      await advancedSync;
      releaseRaceSteps(); await raceStepsDone;
      expect(deliveredVersion).toBe(advanced.version);
      await nextParent;
      await expect(trigger(page, raceStepId)).toBeDisabled();
      releaseParent();
      await expect(trigger(page, raceStepId)).toHaveText(/已完成/);
      await expect(trigger(page, raceStepId)).toBeEnabled();
      await root(page).getByRole('tab', { name: '概览', exact: true }).click();
      await expect(root(page).getByRole('region', { name: '描述', exact: true }).getByText('Parent advanced while Steps read was held.', { exact: true })).toBeVisible();
      expect(raceWrites).toBe(1);
      await info.attach('step-version-advance', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ intermediate: String(afterStep.version), advanced: String(advanced.version), parentReads, raceWrites })) });
    } finally {
      releaseRaceSteps(); releaseParent();
      await page.unroute(raceStatusUrl); await page.unroute(raceParentUrl); await page.unroute(raceCollectionUrl);
    }
    await page.route(deletedUrl, async route => {
      const parent = await (await api.get(`/api/v1/projects/${project.id}/tasks/${deletedTask.id}`)).json();
      const deletion = await api.delete(`/api/v1/projects/${project.id}/tasks/${deletedTask.id}`, { data: { version: parent.version, removeDepends: true } });
      expect(deletion.status()).toBe(204);
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(410);
      await fulfillAuthenticatedResponse(route, response);
    });
    await page.goto(`/projects/${project.id}/tasks/${deletedTask.id}?tab=steps`);
    await choose(page, stepIdForDeleted(), 'done');
    await expect(root(page)).toContainText('任务已删除');
    await page.unroute(deletedUrl);
    await info.attach('step-status-receipts', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ receipts, recoveryIds, writes }, null, 2)) });
  } finally {
    rejectReads = false;
    releaseLate();
    await page.unroute(deletedUrl);
    await page.unroute(statusUrl);
    await page.unroute(collectionUrl);
  }
});


test('step resources retire after actual membership revocation', { annotation: { type: 'scenario', description: 'task-step-access-retirement' } }, async ({ browser, playwright, api, baseURL }, info) => {
  if (baseURL === undefined) throw new Error('Membership acceptance requires the actual service origin.');
  const project = await createProject(api, { name: 'Step permission retirement' });
  const task = await createTask(api, project.id, { title: 'Private task for membership test' });
  const response = await api.post(endpoint(project.id, task.id), { data: { version: task.version, id: 'abcdef12', title: 'Private Step for membership test' } });
  expect(response.status()).toBe(201);
  const bob = await bearerContext(playwright.request, baseURL, 'bob');
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  try {
    const aliceProfile = await (await api.get('/api/v1/me')).json() as { id: string };
    const bobProfile = await (await bob.get('/api/v1/me')).json() as { id: string };
    const invitationResponse = await api.post(`/api/v1/projects/${project.id}/invitations`, { data: { expectedUserId: aliceProfile.id } });
    expect(invitationResponse.status()).toBe(201);
    const invitation = await invitationResponse.json() as { link: string };
    expect((await bob.post('/api/v1/invitations/accept', { data: { token: new URL(invitation.link).hash.slice(1), expectedUserId: bobProfile.id } })).status()).toBe(200);
    await browserAuthentication(context, baseURL, 'bob');
    const bobPage = await context.newPage();
    const now = new Date('2030-01-01T00:00:00Z');
    await bobPage.clock.install({ time: now }); await bobPage.clock.pauseAt(now);
    const writes: string[] = [];
    const errors: string[] = [];
    bobPage.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    bobPage.on('pageerror', error => errors.push(error.name));
    await bobPage.goto(`/projects/${project.id}/tasks/${task.id}?tab=steps`);
    await expect(row(bobPage, 'abcdef12')).toContainText('Private Step for membership test');
    const membersResponse = await api.get(`/api/v1/projects/${project.id}/members`);
    expect(membersResponse.status()).toBe(200);
    const member = parseMembers(await decodeMembersJson(new Response(await membersResponse.text())), project.id).items.find(value => value.userId === bobProfile.id);
    if (member?.directGrant === null || member?.directGrant === undefined) throw new Error('Exact direct grant is required for revocation.');
    const revoke = await api.delete(`/api/v1/projects/${project.id}/members/${bobProfile.id}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: member.directGrant.version, expectedUserId: aliceProfile.id }) });
    expect(revoke.status()).toBe(204);
    const denied = bobPage.waitForResponse(result => new URL(result.url()).pathname === endpoint(project.id, task.id) && result.status() === 404);
    await root(bobPage).getByRole('button', { name: '刷新步骤', exact: true }).click();
    await denied;
    await expect(row(bobPage, 'abcdef12')).toHaveCount(0);
    await expect(bobPage.locator('body')).not.toContainText('Private Step for membership test');
    await expect(bobPage.locator('body')).not.toContainText('Private task for membership test');
    expect(writes).toEqual([]); expect(errors).toEqual([]);
    await screenshot(bobPage, info, 'step-membership-retired');
  } finally { await context.close(); await bob.dispose(); }
});
