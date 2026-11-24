import { expect, test, type Page } from '@playwright/test';
import type { LifecycleIntentReceipt, LifecycleIntentRequest, LifecycleResource } from '../../src/api/worker-lifecycle';
import { WORKER_TIME, WORKER_USER, workerId } from '../helpers/workers';
import { installTools, targetWorker } from './worker-tool-paths-fixture';

const resourceId = workerId(41), instanceId = workerId(42);
const initialResource = (): LifecycleResource => ({
  protocolVersion: 1, workerId: targetWorker, intentVersion: '1', desired: 'enabled', admission: 'open', operationId: null,
  instance: { instanceId }, capability: 'supported', observedAt: WORKER_TIME,
  observation: { protocolVersion: 1, instanceId, intentVersion: '1', operationId: null, localEpoch: '1', scopeGeneration: '1', reportSequence: '1',
    observation: { phase: 'accepting', stop: 'not_started', save: 'pending', sync: 'pending', inventoryComplete: true, detailsComplete: true, inventoryRevision: '1', inventoryDigest: 'a'.repeat(64),
      resourceCount: 1, stoppedCount: 0, pendingCount: 1, blockedCount: 0,
      resources: [{ resourceId, ownerKind: 'task', projectId: workerId(51), taskId: workerId(52), botId: null, executionId: workerId(53), sessionId: workerId(54), executionGeneration: '1', stage: 'running', stop: 'pending', save: 'pending', errorCode: null }],
      recovery: [], errorCode: null, receivedAt: WORKER_TIME, freshUntil: '2026-10-29T13:00:00Z' } },
});

const installLifecycle = async (page: Page, locale: 'en' | 'zh-CN') => {
  const underlying = await installTools(page, { locale });
  const alias = { value: '工作站-long-name-'.repeat(5), version: '1' };
  const state = { resource: initialResource(), writes: [] as LifecycleIntentRequest[], reads: 0, operationReads: 0,
    unknown: false, holdResume: false, releaseResume: () => {}, receipt: null as LifecycleIntentReceipt | null };
  await page.route('**/api/v1/me/workers/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': WORKER_USER, 'X-Daynight-Worker-Lifecycle': '1', 'Daynight-Worker-Alias': '1', 'Daynight-Worker-Tool-Paths': '2' } });
    if (path === `/api/v1/me/workers/${targetWorker}`) return send({ ...underlying.detail, worker: { ...underlying.detail.worker, alias } });
    if (path === `/api/v1/me/workers/${targetWorker}/alias`) return send({ workerId: targetWorker, alias });
    if (path === `/api/v1/me/workers/${targetWorker}/lifecycle`) { state.reads++; return send(state.resource); }
    if (path === `/api/v1/me/workers/${targetWorker}/lifecycle/operations` && request.method() === 'POST') {
      const input = request.postDataJSON() as LifecycleIntentRequest;
      expect(input.expectedVersion).toBe(state.resource.intentVersion);
      state.writes.push(input);
      if (state.holdResume && input.action === 'resume') await new Promise<void>(resolve => { state.releaseResume = resolve; });
      state.receipt = { protocolVersion: 1, workerId: targetWorker, operationId: input.operationId, action: input.action, intentVersion: String(BigInt(input.expectedVersion) + 1n),
        desired: input.action === 'disable' ? 'disabled' : 'enabled', admission: 'closed', state: 'accepted', errorCode: null, observedAt: WORKER_TIME };
      state.resource = { ...state.resource, intentVersion: state.receipt.intentVersion, desired: state.receipt.desired, admission: 'closed', operationId: input.operationId };
      if (state.unknown) return route.abort('failed');
      return send(state.receipt, 202);
    }
    if (state.receipt !== null && path === `/api/v1/me/workers/${targetWorker}/lifecycle/operations/${state.receipt.operationId}`) {
      state.operationReads++;
      return send({ kind: 'intent', receipt: state.receipt, activation: null, activationOutcome: 'not_started' });
    }
    return route.fallback();
  });
  const confirmStopped = () => {
    const envelope = state.resource.observation!;
    state.resource = { ...state.resource, observation: { ...envelope, intentVersion: state.resource.intentVersion, operationId: state.resource.operationId, reportSequence: String(BigInt(envelope.reportSequence) + 1n),
      observation: { ...envelope.observation, phase: 'disabled', stop: 'confirmed', save: 'durable', sync: 'complete', stoppedCount: 1, pendingCount: 0,
        resources: envelope.observation.resources.map(item => ({ ...item, stage: 'stopped' as const, stop: 'confirmed' as const, save: 'durable' as const })),
        recovery: [{ resourceId, recoverability: 'blocked', reasonCode: 'native_unrecoverable' }] } } };
  };
  return { state, confirmStopped };
};

for (const width of [320, 390, 1440]) for (const locale of ['en', 'zh-CN'] as const) test(`${width}px ${locale}: lifecycle confirmation, evidence, recovery and reading continuity`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.clock.install();
  const { state, confirmStopped } = await installLifecycle(page, locale);
  const zh = locale === 'zh-CN';
  await page.goto(`/workers/${targetWorker}`);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  const panel = page.locator('.worker-lifecycle:not(.worker-lifecycle-compact)');
  const disable = panel.getByRole('button', { name: zh ? '保存现场并停用' : 'Save and disable', exact: true });
  await expect(disable).toBeEnabled();
  await disable.focus(); await page.keyboard.press('Enter');
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(disable).toBeFocused(); expect(state.writes).toHaveLength(0);
  await disable.click(); dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(zh ? '租约可能到期' : 'leases may expire');
  await expect(dialog).toContainText(zh ? '不会关闭电脑' : 'does not shut down');
  await dialog.getByRole('button', { name: zh ? '确认' : 'Confirm', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(panel.getByText(zh ? '等待本机确认' : 'Awaiting machine confirmation', { exact: true })).toBeVisible();
  await expect(panel.locator('.worker-lifecycle-safe')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: zh ? '恢复服务' : 'Resume service', exact: true })).toBeVisible();
  confirmStopped();
  await panel.getByRole('button', { name: zh ? '重新核对' : 'Check again', exact: true }).click();
  await expect(panel.locator('.worker-lifecycle-safe')).toBeVisible();
  await panel.locator('summary').click();
  await expect(panel.locator('details')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: zh ? '修改别名' : 'Edit alias', exact: true }).click();
  const draft = page.getByRole('textbox', { name: zh ? 'Worker 别名' : 'Worker alias', exact: true });
  await draft.fill('Retain this local draft');
  const scrollY = await page.evaluate(() => window.scrollY);
  const reads = state.reads;
  const envelope = state.resource.observation!;
  state.resource = { ...state.resource, observation: { ...envelope, reportSequence: String(BigInt(envelope.reportSequence) + 1n), observation: { ...envelope.observation, sync: 'failed' } } };
  await page.clock.fastForward(30_000);
  await expect.poll(() => state.reads).toBeGreaterThan(reads);
  await expect(draft).toHaveValue('Retain this local draft'); await expect(draft).toBeFocused();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - scrollY)).toBeLessThanOrEqual(1);
  await expect(panel.locator('details')).toHaveAttribute('open', '');
  await expect(panel).toContainText(zh ? '远端记录尚未全部同步' : 'Remote records are not fully synchronized');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await panel.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await info.attach('lifecycle-large-text', { body: await page.screenshot(), contentType: 'image/png' });
  state.holdResume = true;
  await panel.getByRole('button', { name: zh ? '恢复服务' : 'Resume service', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: zh ? '确认' : 'Confirm', exact: true }).click();
  try {
    await expect.poll(() => state.writes.length).toBe(2);
    await expect(panel.locator('.worker-lifecycle-safe')).toHaveCount(0);
    await expect(panel.getByText(zh ? '已停用' : 'Disabled', { exact: true })).toHaveCount(0);
    await expect(draft).toHaveValue('Retain this local draft');
  } finally { state.releaseResume(); }
});

test('unknown disable survives refresh and queries its original operation without another intent write', async ({ page }) => {
  const { state } = await installLifecycle(page, 'en');
  state.unknown = true;
  await page.goto(`/workers/${targetWorker}`);
  await page.getByRole('button', { name: 'Save and disable', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByText(/The result is unknown/)).toBeVisible();
  const operationId = state.writes[0]!.operationId;
  await page.reload();
  await expect.poll(() => state.operationReads).toBeGreaterThan(0);
  expect(state.writes).toHaveLength(1);
  expect(state.receipt?.operationId).toBe(operationId);
  await expect(page.locator('.worker-lifecycle-safe')).toHaveCount(0);
});
