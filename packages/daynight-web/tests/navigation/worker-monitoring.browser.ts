import { expect, test, type Page } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId, workerPage, workerSummary } from '../helpers/workers';
import { configurationResource } from '../helpers/worker-configuration';

const target = workerId(1), projectId = workerId(301), taskId = workerId(201), personalId = workerId(90);
const scope = { kind: 'claim', projectId, taskId, claimId: workerId(401) };
const longTitle = `Long task ${'monitoring-'.repeat(28)}`;
const longPath = `../retained/${'工作目录-long-path-'.repeat(18)}task`;
const longWorkerName = `Worker ${'long-name-'.repeat(12)}`;
const association = { kind: 'task', projectName: 'Monitoring project', title: longTitle };
const retainedOwners = Array.from({ length: 5 }, (_, index) => ({
  scope: { kind: 'claim', projectId, taskId: workerId(202 + index), claimId: workerId(402 + index) },
  association: { kind: 'task', projectName: 'Monitoring project', title: index === 0 ? longTitle : `Retained task ${index + 1}` },
  path: index === 0 ? longPath : `.worktrees/daynight/${workerId(502 + index)}`,
}));
const retainedObservation = () => ({
  reservations: [
    { reservationId: workerId(700), scope, association: { ...association, title: 'Snapshot task' }, roles: ['active-task', 'resource-owner'], occupied: true, observedAt: WORKER_TIME },
    ...retainedOwners.map((owner, index) => ({ reservationId: workerId(701 + index), scope: owner.scope, association: owner.association, roles: ['resource-owner'], occupied: true, observedAt: WORKER_TIME })),
  ],
  activities: [{ operationId: workerId(600), kind: 'execution', phase: 'executing', status: 'running', scope, association: { ...association, title: 'Snapshot task' }, startedAt: WORKER_TIME, lastProgressAt: WORKER_TIME, elapsedMs: 2000, deadlineAt: null, waitReason: null, nextAttemptAt: null }],
  currentFailures: retainedOwners.map((owner, index) => ({ operationId: workerId(601 + index), component: 'resources', phase: 'resource-observation', scope: owner.scope, association: owner.association,
    worktree: { kind: 'project-relative', path: owner.path }, error: { type: 'operation', code: 'ownership-unconfirmed', cause: 'Retained resource ownership is unconfirmed; automatic cleanup is unsafe.', causeTruncated: false },
    firstObservedAt: WORKER_TIME, lastObservedAt: WORKER_TIME, occurrencesInRun: 3, retryState: 'manual', nextAttemptAt: null,
  })),
});
const install = async (page: Page, retained = false, locale = 'zh-CN') => {
  const state = { fail: false, activity: true };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, json, headers: { 'Daynight-User-ID': WORKER_USER, ...extra } });
    const personal = { id: personalId, kind: 'personal', name: null };
    const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: WORKER_USER, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
    const project = { id: projectId, name: 'Monitoring project', repoUrl: 'https://example.test/project.git', settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: personalId, version: 1 }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME };
    const failure = { error: { code: 'monitoring_unavailable', message: 'Unavailable', requestId: 'fixture' } };
    const scheduler = { phase: 'waiting-poll', coverage: 'complete', lastSuccessfulAt: WORKER_TIME, nextPollAt: null };
    const capacity = { observedAt: WORKER_TIME, quality: 'current', limit: retained ? 6 : 2, occupied: retained ? 6 : 2, available: 0, ...(retained ? { breakdown: { active: 1, retained: 5 } } : {}) };
    const common = { revision: workerId(4), receivedAt: WORKER_TIME, expiresAt: '2026-10-29T13:00:00.123456789Z' };
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(project);
    if (path === '/api/v1/me/workers') return send(workerPage([{ ...workerSummary(), machine: { ...workerSummary().machine, name: longWorkerName } }]));
    if (path === `/api/v1/me/workers/${target}`) { const detail = workerDetail(); detail.worker.tasks[0]!.title = longTitle; return send(detail, 200, { 'Daynight-Worker-Tool-Paths': '2' }); }
    if (path === `/api/v1/me/workers/${target}/configuration`) return send(configurationResource(), 200, { 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' });
    if (path === '/api/v1/me/workers/monitoring/query') return state.fail ? send(failure, 503) : send({ observedAt: WORKER_TIME, items: [{ workerId: target, state: 'available', ...common, summary: { capturedAt: WORKER_TIME, lifecycle: 'running', scheduler, capacity, detailCoverage: 'complete', admission: { observedAt: WORKER_TIME, coverage: 'complete', reasonCodes: [retained ? 'capacity-full' : 'cleanup-capacity-blocked'], permissionProjection: 'current' } } }] });
    if (path === `/api/v1/me/workers/${target}/monitoring`) return state.fail ? send(failure, 503) : send({ observedAt: WORKER_TIME, state: 'available', ...common, runId: workerId(5), sequence: '1', detailCoverage: 'complete', permissionProjection: 'current', data: {
      runId: workerId(5), sequence: '1', capturedAt: WORKER_TIME, lifecycle: 'running', scheduler: { ...scheduler, cycleId: null, lastCompletedAt: WORKER_TIME, lastOutcome: 'completed' }, capacity: { ...capacity, detailCoverage: 'complete' },
      admission: { observedAt: WORKER_TIME, coverage: 'complete', reasons: [{ code: retained ? 'capacity-full' : 'cleanup-capacity-blocked', scope: { kind: 'worker' }, association: null, observedAt: WORKER_TIME, nextAttemptAt: null }] }, reservations: [],
      activities: state.activity ? [{ operationId: workerId(6), kind: 'cleanup', phase: 'worktree-removal', status: 'waiting', scope, association, startedAt: WORKER_TIME, lastProgressAt: null, elapsedMs: 2000, deadlineAt: null, waitReason: 'retry-backoff', nextAttemptAt: WORKER_TIME }] : [],
      currentFailures: [{ operationId: workerId(6), component: retained ? 'resources' : 'cleanup', phase: retained ? 'resource-observation' : 'worktree-removal', scope, association, worktree: { kind: 'project-relative', path: longPath }, error: { type: 'operation', code: retained ? 'ownership-unconfirmed' : 'command-failed', cause: retained ? 'Retained resource ownership is unconfirmed; automatic cleanup is unsafe.' : 'A required command failed.', causeTruncated: false }, firstObservedAt: WORKER_TIME, lastObservedAt: WORKER_TIME, occurrencesInRun: 3, retryState: retained ? 'manual' : 'scheduled', nextAttemptAt: retained ? null : WORKER_TIME }], lastRecovery: null, detailCoverage: 'complete', delivery: { lastSucceededAt: WORKER_TIME, lastFailure: null },
      ...(retained ? retainedObservation() : {}),
    } });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  return state;
};

for (const width of [1360, 390, 320]) test(`monitoring interactions and reading stability at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1360 ? 900 : 844 });
  const state = await install(page); await page.goto('/workers');
  await expect(page.locator('.monitoring-card-state')).toContainText('2 / 2');
  await expect(page.locator('.monitoring-card-state')).not.toContainText('清理占用容量');
  const card = page.locator(`a.worker-card[href="/workers/${target}"]`);
  await expect(card).toContainText(longWorkerName);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (width === 320) { await card.focus(); await page.keyboard.press('Enter'); }
  else await card.click();
  await expect(page.getByText('清理占用容量')).toBeVisible();
  const monitoringTime = page.locator('.monitoring-time');
  await expect(monitoringTime).toHaveCount(1); await expect(monitoringTime).toContainText('收到时间'); await expect(monitoringTime).toContainText('采集时间');
  const taskPanel = page.locator('.worker-task-heading-label').locator('xpath=ancestor::section[1]');
  expect(await monitoringTime.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('.worker-task-heading-label')!.closest('section')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const timeBox = await monitoringTime.boundingBox(), taskBox = await taskPanel.boundingBox();
  expect(timeBox!.y + timeBox!.height).toBeLessThanOrEqual(taskBox!.y);
  if (width === 320) expect(await monitoringTime.evaluate(element => element.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(element).lineHeight))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('monitoring-time.png'), fullPage: true });
  const tabs = page.locator('[data-worker-tab="overview"]:visible'); await tabs.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-worker-tab="configuration"]:visible')).toHaveAttribute('aria-selected', 'true');
  await expect(monitoringTime).toBeHidden();
  await page.keyboard.press('ArrowLeft'); await expect(tabs).toHaveAttribute('aria-selected', 'true'); await expect(monitoringTime).toBeVisible();
  const issue = page.locator('.monitoring-issue'); await issue.locator('summary').click();
  await expect(issue).toHaveAttribute('open', ''); await expect(issue).toContainText('所需命令失败。');
  const path = issue.locator('code.monitoring-worktree'); await expect(path).toHaveText(longPath);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await issue.scrollIntoViewIfNeeded();
  await issue.locator('summary').focus();
  await path.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  // Finish the user scroll event before triggering an unrelated background response.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const before = await issue.boundingBox(); state.activity = false;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByText('未报告活动。')).toBeVisible(); await expect(issue).toHaveAttribute('open', '');
  await expect(issue.locator('summary')).toBeFocused(); expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(longPath);
  const after = await issue.boundingBox(); expect(Math.abs(after!.y - before!.y)).toBeLessThan(4);
  state.fail = true; await page.getByRole('button', { name: '刷新', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: '运行监控更新失败' }); await expect(alert).toBeVisible();
  await expect(monitoringTime).toHaveCount(1); await expect(monitoringTime).toContainText('采集时间');
  expect(await taskPanel.evaluate(panel => !!(panel.compareDocumentPosition(document.querySelector('.monitoring-notice')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(issue).toHaveAttribute('open', ''); state.fail = false;
  await alert.getByRole('button', { name: '重试' }).click(); await expect(alert).toHaveCount(0);
  await expect(monitoringTime).toHaveCount(1);
  await issue.getByRole('link', { name: longTitle }).click(); await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${taskId}`));
  await page.goBack(); await expect(page.getByText('清理占用容量')).toBeVisible();
  const taskLink = page.locator('.worker-task-table').getByRole('link', { name: longTitle });
  await taskLink.click(); await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${taskId}`));
  await page.goBack(); await expect(page.getByText('清理占用容量')).toBeVisible();
  const resources = page.locator('.worker-metric-grid'); await resources.scrollIntoViewIfNeeded();
  const resourceBefore = await resources.boundingBox();
  await page.evaluate(() => { const original = performance.now.bind(performance); Object.defineProperty(performance, 'now', { configurable: true, value: () => original() + 3_600_000 }); });
  await expect(page.getByText('运行观测已过期')).toBeVisible({ timeout: 5000 });
  await expect(monitoringTime).toHaveCount(0);
  const resourceAfter = await resources.boundingBox(); expect(Math.abs(resourceAfter!.y - resourceBefore!.y)).toBeLessThan(4);
});

for (const locale of ['zh-CN', 'en']) for (const width of [1360, 390, 320]) test(`retained resources show recovery evidence at ${width}px in ${locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await install(page, true, locale); await page.goto(`/workers/${target}`);
  await expect(page.getByText('6 / 6')).toBeVisible();
  if (locale === 'en' && width <= 390) expect(await page.locator('.monitoring-time').evaluate(element => element.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(element).lineHeight))).toBe(true);
  const taskPanel = page.locator('.worker-task-heading-label').locator('xpath=ancestor::section[1]');
  const taskLink = taskPanel.getByRole('link', { name: longTitle });
  await expect(taskLink).toHaveAttribute('href', new RegExp(`/projects/${projectId}/tasks/${taskId}`));
  for (const selector of ['.monitoring-content', '.worker-sample-time', '.worker-metric-grid', '.worker-detail-columns']) {
    expect(await taskPanel.evaluate((panel, targetSelector) => !!(panel.compareDocumentPosition(document.querySelector(targetSelector)!) & Node.DOCUMENT_POSITION_FOLLOWING), selector)).toBe(true);
  }
  const taskBox = await taskPanel.boundingBox(), monitoringBox = await page.locator('.monitoring-content').boundingBox();
  expect(monitoringBox!.y - (taskBox!.y + taskBox!.height)).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const active = page.getByText(locale === 'zh-CN' ? '活动任务占用' : 'Active task occupancy');
  const retained = page.getByText(locale === 'zh-CN' ? '保留资源占用' : 'Retained resource occupancy');
  await expect(active.locator('xpath=following-sibling::dd[1]')).toHaveText('1');
  await expect(retained.locator('xpath=following-sibling::dd[1]')).toHaveText('5');
  const responsibilities = page.locator('.monitoring-reservations > li');
  await expect(responsibilities).toHaveCount(6);
  await expect(responsibilities.first()).toContainText(locale === 'zh-CN' ? '活动任务' : 'Active task');
  await expect(page.locator('.monitoring-activities > li')).toHaveCount(1);
  const issues = page.locator('.monitoring-issue'); await expect(issues).toHaveCount(5);
  for (const [index, owner] of retainedOwners.entries()) {
    const issue = issues.nth(index); await issue.locator('summary').click();
    await expect(issue.getByText(owner.scope.claimId, { exact: true })).toBeVisible();
    await expect(issue.locator('.monitoring-recovery-command')).toHaveText(`daynight worker resources recover ${owner.scope.taskId} --project ${projectId} --claim-id ${owner.scope.claimId}`);
    await expect(issue.locator('.monitoring-worktree')).toHaveText(owner.path);
    await expect(issue.getByRole('link', { name: owner.association.title })).toHaveAttribute('href', new RegExp(`/projects/${projectId}/tasks/${owner.scope.taskId}`));
    await expect(responsibilities.nth(index + 1).getByRole('link', { name: owner.association.title })).toHaveAttribute('href', new RegExp(`/projects/${projectId}/tasks/${owner.scope.taskId}`));
  }
  const issue = issues.first();
  await page.screenshot({ path: testInfo.outputPath('retained-resources.png'), fullPage: true });
  await issue.screenshot({ path: testInfo.outputPath('retained-failure.png') });
  if (width <= 390) expect(await issue.locator('dl').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
