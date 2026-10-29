import { readProjectSnapshot } from './project-snapshot';
import { closeChain, openChain } from './chain-dialog';
import { selectTaskList } from './project-view';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { APIResponse, Locator, Page, Route, TestInfo } from '@playwright/test';
import { createAcceptanceCli } from '../../scripts/acceptance/installed-cli.mts';
import { parseApiJson, stringifyApiJson } from '../../src/api/json';
import { parseServerError, parseTaskDetail } from '../../src/api/parse';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import type { TaskDetail, TaskStatus } from '../../src/api/types';
import { attachmentDownloadUrl } from '../../src/api/client';
import { createProject, createTask, expect, seedTaskVersion, seedExternalDependencies, setTaskStatus, test } from './fixtures';
import { expectCenteredTaskDetail } from './detail-dialog';
import { authenticatedAPI, fulfillAuthenticatedResponse, type AuthenticatedAPI } from './authentication';

const states: readonly TaskStatus[] = ['todo', 'in_progress', 'done'];
const labels = { 'zh-CN': { todo: '待处理', in_progress: '进行中', done: '已完成' }, en: { todo: 'To do', in_progress: 'In progress', done: 'Done' } };
const detail = (page: Page): Locator => page.locator('.task-detail-dialog');
const trigger = (page: Page): Locator => detail(page).locator('.task-detail-status-row .task-status-trigger');
const confirmation = (page: Page): Locator => page.getByRole('alertdialog', { name: /^(设置任务状态|Set task status)$/ });
const taskPath = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}`;
const origin = (info: TestInfo): string => {
  if (typeof info.project.use.baseURL !== 'string') throw new Error('Status acceptance requires the actual service origin.');
  return new URL(info.project.use.baseURL).origin;
};
const screenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const pauseAutomaticRefresh = async (page: Page): Promise<void> => {
  const now = new Date('2030-01-01T00:00:00Z'); await page.clock.install({ time: now }); await page.clock.pauseAt(now);
};
const open = async (page: Page, project: string, task: string): Promise<void> => {
  const syncPath = `/api/v1/projects/${project}/task-sync`;
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === syncPath && response.status() === 200);
  if (new URL(page.url()).pathname !== `/projects/${project}`) await page.goto(`/projects/${project}`);
  else {
    if (await detail(page).count() > 0) await detail(page).getByRole('button', { name: /^(关闭任务详情|Close task details)$/, exact: true }).click();
    await closeChain(page);
    await page.getByRole('button', { name: /^(刷新|Refresh)$/, exact: true }).click();
  }
  await (await response).finished();
  const { graph } = await readProjectSnapshot(authenticatedAPI(page.context().request), project);
  const index = buildGraphIndex(graph); const representative = index.componentByTask.get(task)!;
  const standalone = index.components.get(representative)!.memberIds.size === 1;
  await selectTaskList(page);
  await page.getByRole('tab', { name: standalone ? /^(独立任务|Standalone tasks)$/ : /^(任务链|Task chains)$/, exact: true }).click();
  await page.locator('.completed-chain-control input').check();
  if (standalone) await page.locator(`#standalone-task-${task}`).click();
  else {
    await openChain(page, representative);
    await page.locator(`.react-flow__node[data-id="${task}"] .task-node-details`).click();
  }
  await expect(detail(page)).toBeVisible(); await expect(trigger(page)).toBeEnabled();
};
const select = async (page: Page, status: TaskStatus, locale: keyof typeof labels = 'zh-CN'): Promise<void> => {
  await trigger(page).click();
  const options = page.getByRole('menuitemradio'); await expect(options).toHaveCount(3);
  await page.getByRole('menuitemradio', { name: labels[locale][status], exact: true }).click();
  await expect(confirmation(page)).toBeVisible();
};
const confirm = async (page: Page): Promise<void> => {
  await confirmation(page).getByRole('button', { name: /^(确认设置|Confirm status)$/, exact: true }).click();
};
const expectConfirmed = async (page: Page): Promise<void> => {
  await expect(detail(page).locator('.task-status-feedback [role="status"]')).toHaveText(/^(任务状态已确认。|Task status confirmed\.)$/);
  await expect(detail(page).locator('.task-status-error')).toHaveCount(0);
};
const invariant = (task: TaskDetail) => ({ id: task.id, projectId: task.projectId, title: task.title, description: task.description,
  properties: task.properties, allowAgents: task.allowAgents, requiredPlatform: task.requiredPlatform, dependsOn: task.dependsOn, externalDependsOn: task.externalDependsOn, createdAt: task.createdAt });
const read = async (api: AuthenticatedAPI, project: string, task: string): Promise<TaskDetail> => {
  const response = await api.get(taskPath(project, task)); expect(response.status()).toBe(200);
  return parseTaskDetail(parseApiJson(await response.text()), project, task);
};
const actor = async (page: Page, info: TestInfo, name: string) => {
  const receiptPath = process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT;
  if (receiptPath === undefined) throw new Error('Status evidence requires an installed CLI receipt.');
  const cli = await createAcceptanceCli(origin(info), info.outputPath(`installed-cli-${name}`));
  const evidence = { scenario: name, topology: process.env.DAYNIGHT_ACCEPTANCE_TARGET, installedCli: JSON.parse(await readFile(receiptPath, 'utf8')) as unknown,
    commands: [] as { argv: readonly string[]; exitCode: number; stdout: string; stderr: string }[],
    writes: [] as { taskId: string; body: string; status: number; responseBody: string; requestId: string | null }[],
    snapshots: [] as { label: string; task: TaskDetail }[], controlledFaults: [] as string[] };
  const run = async (argv: readonly string[]) => { const result = await cli.run(argv); evidence.commands.push({ argv, ...result }); return result; };
  const success = async (argv: readonly string[]): Promise<string> => { const result = await run(argv); expect(result.exitCode).toBe(0); expect(result.stderr).toBe(''); return result.stdout; };
  const show = async (project: string, task: string, label: string): Promise<TaskDetail> => {
    const value = parseTaskDetail(parseApiJson(await success(['task', 'show', task, '--project', project, '--json'])), project, task);
    evidence.snapshots.push({ label, task: value }); return value;
  };
  const capture = async (route: Route, taskId: string): Promise<APIResponse> => {
    expect(route.request().method()).toBe('PUT'); expect(new URL(route.request().url()).pathname.endsWith('/status')).toBe(true);
    const body = route.request().postData()!; const parsed = parseApiJson(body) as { version: bigint; status: TaskStatus };
    expect(Object.keys(parsed).sort()).toEqual(['status', 'version']); expect(typeof parsed.version).toBe('bigint'); expect(states).toContain(parsed.status);
    const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
    evidence.writes.push({ taskId, body, status: response.status(), responseBody: await response.text(), requestId: response.headers()['x-request-id'] ?? null }); return response;
  };
  const attach = async () => info.attach(`${name}-receipt`, { contentType: 'application/json',
    body: Buffer.from(JSON.stringify(evidence, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2)) });
  return { cli, evidence, run, success, show, capture, attach };
};
const resourceId = (text: string): string => {
  const ids = [...text.matchAll(/^ID: ([0-9a-f-]{36})$/gm)]; expect(ids).toHaveLength(1); return ids[0]![1]!;
};

test('task-status', { annotation: { type: 'scenario', description: 'task-status' } }, async ({ page, api, allowStatusWrites }, info) => {
  await pauseAutomaticRefresh(page);
  const lifecycle = await actor(page, info, 'task-status');
  try {
    const project = resourceId(await lifecycle.success(['project', 'create', `Status ${randomUUID()}`, '--repo', `https://example.com/status/${randomUUID()}`]));
    const id = resourceId(await lifecycle.success(['task', 'create', '--project', project, '--title', '完整任务标题 '.repeat(20), '--description', '# 状态交付\n\n保留正文、PR、附件与阅读位置。', '--pull-request-url', 'https://example.com/pull/1', '--pull-request-title', 'Preserved reference', '--required-platform', 'macos']));
    const created = await lifecycle.show(project, id, 'created'); expect(created).toMatchObject({ status: 'todo', version: 1n, ready: true, allowAgents: false, requiredPlatform: 'macos', startedAt: null, completedAt: null });
    const content = Buffer.from('状态修改前后的附件内容一致。\n');
    const attachment = attachmentDownloadUrl(project, id, 'plan.md');
    expect((await api.put(attachment, { data: content, headers: { 'Content-Type': 'text/markdown' } })).status()).toBe(201);
    const exactVersion = 9007199254740993n; await seedTaskVersion(project, id, exactVersion);
    allowStatusWrites([{ origin: origin(info), projectId: project, taskId: id, status: 'todo', count: 1 }, { origin: origin(info), projectId: project, taskId: id, status: 'in_progress', count: 1 }]);
    const endpoint = new URL(`${taskPath(project, id)}/status`, origin(info)).href;
    await page.route(endpoint, async (route) => { const response = await lifecycle.capture(route, id); await fulfillAuthenticatedResponse(route, response); });
    await open(page, project, id); await expectCenteredTaskDetail(page, detail(page));
    await expect(detail(page).locator('.task-detail-title')).toHaveText(created.title);
    await expect(detail(page).locator('.task-detail-header').getByRole('combobox')).toHaveCount(0);
    await expect(page.locator('.stats .stat')).toHaveCount(6);
    await trigger(page).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitemradio', { name: '待处理', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('End'); await expect(page.getByRole('menuitemradio', { name: '已完成', exact: true })).toBeFocused();
    await page.keyboard.press('Home'); await expect(page.getByRole('menuitemradio', { name: '待处理', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitemradio', { name: '进行中', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused(); expect(lifecycle.evidence.writes).toHaveLength(0);
    for (const cancellation of ['取消', 'Escape']) {
      await select(page, 'done'); await expect(confirmation(page)).toContainText(created.title);
      await expect(confirmation(page).getByRole('button', { name: '取消', exact: true })).toBeFocused();
      if (cancellation === 'Escape') await page.keyboard.press('Escape'); else await confirmation(page).getByRole('button', { name: cancellation, exact: true }).click();
      await expect(trigger(page)).toBeFocused(); expect(lifecycle.evidence.writes).toHaveLength(0);
    }
    const beforeNoop = await lifecycle.show(project, id, 'reviewed-same-state');
    await select(page, 'todo'); await confirm(page); await expect(trigger(page)).toBeEnabled(); await expectConfirmed(page);
    expect(await lifecycle.show(project, id, 'same-state-confirmed')).toEqual(beforeNoop);
    expect(lifecycle.evidence.writes[0]!.body).toBe(stringifyApiJson({ version: exactVersion, status: 'todo' }));
    await detail(page).getByRole('tab', { name: '附件', exact: true }).click();
    await detail(page).locator('button.attachment-file').filter({ hasText: 'plan.md' }).click();
    await expect(detail(page)).toContainText(content.toString().trim());
    const attachmentsPanel = detail(page).getByRole('tabpanel'); const panelIdentity = await attachmentsPanel.getAttribute('id');
    await select(page, 'in_progress'); await confirm(page); await expect(trigger(page)).toHaveText(/进行中/); await expectConfirmed(page);
    await expect(detail(page).getByRole('tab', { name: '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(await detail(page).getByRole('tabpanel').getAttribute('id')).toBe(panelIdentity);
    await expect(detail(page)).toContainText(content.toString().trim());
    const running = await lifecycle.show(project, id, 'web-running'); expect(invariant(running)).toEqual(invariant(created));
    expect(running.version).toBe(exactVersion + 1n); expect(running.startedAt).not.toBeNull(); expect(running.completedAt).toBeNull();
    const stale = await lifecycle.run(['task', 'set-status', id, 'in_progress', '--project', project, '--if-version', String(exactVersion)]);
    expect(stale.exitCode).toBe(1); expect(stale.stderr).toContain('version_conflict');
    await lifecycle.success(['task', 'set-status', id, 'done', '--project', project, '--if-version', String(running.version)]);
    const done = await lifecycle.show(project, id, 'cli-done'); expect(done.startedAt).toBe(running.startedAt); expect(done.completedAt).not.toBeNull();
    expect(invariant(done)).toEqual(invariant(created));
    const stored = await api.get(attachment); expect(stored.status()).toBe(200); expect(createHash('sha256').update(await stored.body()).digest('hex')).toBe(createHash('sha256').update(content).digest('hex'));
    await page.unroute(endpoint); await page.reload(); await open(page, project, id); await expect(trigger(page)).toHaveText(/已完成/);
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
    await open(page, project, id); await expect(trigger(page)).toHaveText(/Done/);
    for (const width of [1600, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await select(page, 'todo', 'en');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await screenshot(page, info, `status-confirmation-en-${width}`); await page.keyboard.press('Escape');
    }
  } finally { await lifecycle.attach(); await lifecycle.cli.close(); }
});

test('task-status-conflicts', { annotation: { type: 'scenario', description: 'task-status-conflicts' } }, async ({ page, api, allowStatusWrites }, info) => {
  await pauseAutomaticRefresh(page);
  const lifecycle = await actor(page, info, 'task-status-conflicts');
  const project = await createProject(api); const task = await createTask(api, project.id, { title: '版本冲突与完整内容重新审阅' });
  const prerequisite = await createTask(api, project.id, { title: '普通与外部前置' });
  const blocked = await createTask(api, project.id, { title: '依赖拒绝', dependsOn: [prerequisite.id] });
  allowStatusWrites([{ origin: origin(info), projectId: project.id, taskId: task.id, status: 'in_progress', count: 2 },
    { origin: origin(info), projectId: project.id, taskId: blocked.id, status: 'done', count: 1 }]);
  const endpoint = new URL(`${taskPath(project.id, task.id)}/status`, origin(info)).href;
  let injectConflict = true;
  await page.route(endpoint, async (route) => {
    if (injectConflict) {
      injectConflict = false;
      await lifecycle.success(['task', 'update', task.id, '--project', project.id, '--if-version', String(task.version), '--description', 'CLI 在确认后修改了正文。']);
    }
    const response = await lifecycle.capture(route, task.id); await fulfillAuthenticatedResponse(route, response);
  });
  try {
    await open(page, project.id, task.id); await select(page, 'in_progress'); await confirm(page);
    await expect(trigger(page)).toBeEnabled(); await expect(detail(page)).toContainText('CLI 在确认后修改了正文。');
    expect(lifecycle.evidence.writes).toHaveLength(1); expect(lifecycle.evidence.writes[0]!.status).toBe(409);
    const conflict = lifecycle.evidence.writes[0]!;
    const refusal = parseServerError(parseApiJson(conflict.responseBody));
    expect(refusal.code).toBe('version_conflict');
    expect(conflict.requestId).toBe(refusal.requestId);
    await expect(detail(page)).toContainText(refusal.requestId);
    const changed = await lifecycle.show(project.id, task.id, 'conflict-readback'); expect(changed.status).toBe('todo');
    await select(page, 'in_progress'); await confirm(page); await expect(trigger(page)).toHaveText(/进行中/); await expectConfirmed(page);
    const running = await lifecycle.show(project.id, task.id, 'new-reviewed-submission'); expect(running.version).toBe(changed.version + 1n);
    expect(lifecycle.evidence.writes[1]!.body).toBe(stringifyApiJson({ version: changed.version, status: 'in_progress' }));
    const blockedEndpoint = new URL(`${taskPath(project.id, blocked.id)}/status`, origin(info)).href;
    await page.route(blockedEndpoint, async (route) => { const response = await lifecycle.capture(route, blocked.id); await fulfillAuthenticatedResponse(route, response); });
    await open(page, project.id, blocked.id); await select(page, 'done'); await confirm(page);
    await expect(trigger(page)).toBeEnabled(); expect(lifecycle.evidence.writes[2]!.status).toBe(409);
    const dependencyRefusal = parseServerError(parseApiJson(lifecycle.evidence.writes[2]!.responseBody));
    expect(dependencyRefusal.code).toBe('dependency_unsatisfied');
    expect(lifecycle.evidence.writes[2]!.requestId).toBe(dependencyRefusal.requestId);
    expect(lifecycle.evidence.writes[2]!.responseBody).toContain(prerequisite.id);
    await expect(detail(page)).toContainText(dependencyRefusal.requestId);
    expect(await read(api, project.id, blocked.id)).toMatchObject({ status: 'todo', version: 1n });
    await page.unroute(blockedEndpoint);
    // A changed edge classification is a new review, even when its endpoints remain equal.
    const classified = await seedExternalDependencies(api, project.id, blocked, [prerequisite.id]);
    await open(page, project.id, blocked.id); await select(page, 'todo');
    await seedExternalDependencies(api, project.id, classified, []);
    await page.clock.runFor(5_100);
    await expect(confirmation(page)).toHaveCount(0);
    await expect(detail(page).locator('.task-detail-relation-external')).toHaveCount(0);
    expect(lifecycle.evidence.writes).toHaveLength(3);
    await screenshot(page, info, 'status-conflict-reloaded');
  } finally { await page.unroute(endpoint); await lifecycle.attach(); await lifecycle.cli.close(); }
});

test('task-status-recovery', { annotation: { type: 'scenario', description: 'task-status-recovery' } }, async ({ page, api, allowStatusWrites }, info) => {
  await pauseAutomaticRefresh(page);
  const lifecycle = await actor(page, info, 'task-status-recovery');
  const project = await createProject(api); const task = await createTask(api, project.id, { title: '丢响应后的实际状态核对' });
  const other = await createTask(api, project.id, { title: '隔离其他任务的写入会话' });
  allowStatusWrites([{ origin: origin(info), projectId: project.id, taskId: task.id, status: 'in_progress', count: 1 },
    { origin: origin(info), projectId: project.id, taskId: task.id, status: 'done', count: 1 },
    { origin: origin(info), projectId: project.id, taskId: task.id, status: 'todo', count: 1 }]);
  const endpoint = new URL(`${taskPath(project.id, task.id)}/status`, origin(info)).href;
  const resource = new URL(taskPath(project.id, task.id), origin(info)).href;
  let rejectReadback = false; let mode: 'unknown' | 'pending' | 'ordinary' = 'unknown';
  const pending = deferred(); const release = deferred();
  await page.route(resource, async (route) => { if (rejectReadback) await route.abort('connectionfailed'); else await route.continue(); });
  await page.route(endpoint, async (route) => {
    const response = await lifecycle.capture(route, task.id);
    if (mode === 'unknown') { mode = 'ordinary'; rejectReadback = true; lifecycle.evidence.controlledFaults.push('Real status commit succeeded; its response and following task GET were lost.'); await route.abort('connectionfailed'); return; }
    if (mode === 'pending') { mode = 'ordinary'; pending.resolve(); await release.promise; }
    await fulfillAuthenticatedResponse(route, response);
  });
  try {
    await open(page, project.id, task.id); await select(page, 'in_progress'); await confirm(page);
    await expect(trigger(page)).toBeDisabled(); await expect(detail(page).getByRole('switch')).toBeDisabled();
    await expect(detail(page).getByRole('combobox', { name: /^(执行平台|Execution platform)$/, exact: true })).toBeDisabled();
    const retry = detail(page).getByRole('button', { name: /^(检查任务状态|Check task state)$/ });
    await expect(retry).toBeEnabled(); expect(lifecycle.evidence.writes).toHaveLength(1);
    const actual = await lifecycle.show(project.id, task.id, 'committed-with-lost-response'); expect(actual.status).toBe('in_progress');
    rejectReadback = false; await retry.click(); await expect(trigger(page)).toBeEnabled(); await expect(trigger(page)).toHaveText(/进行中/);
    expect(lifecycle.evidence.writes).toHaveLength(1);
    await expect(detail(page).getByRole('switch')).toBeDisabled();
    mode = 'pending'; await select(page, 'done'); await confirm(page); await pending.promise;
    await expect(trigger(page)).toBeDisabled(); await expect(detail(page).getByRole('switch')).toBeDisabled();
    await expect(detail(page).getByRole('combobox', { name: /^(执行平台|Execution platform)$/, exact: true })).toBeDisabled();
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await open(page, project.id, other.id); await expect(trigger(page)).toHaveText(/待处理/);
    const committedResponse = page.waitForResponse((response) => response.url() === endpoint && response.request().method() === 'PUT');
    // The session synchronizes task summaries only after publishing its confirmed write.
    const confirmedSync = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync` && response.status() === 200);
    release.resolve();
    const delivered = await committedResponse; expect(delivered.status()).toBe(200); expect(await delivered.finished()).toBeNull();
    expect(await (await confirmedSync).finished()).toBeNull();
    await page.clock.runFor(32);
    expect(await lifecycle.show(project.id, task.id, 'pending-original-task')).toMatchObject({ status: 'done' });
    await expect(trigger(page)).toHaveText(/待处理/);
    await open(page, project.id, task.id); await expect(trigger(page)).toHaveText(/已完成/);
    await expect(detail(page).locator('.task-status-feedback [role="status"]')).toHaveCount(0);
    expect(lifecycle.evidence.writes).toHaveLength(2);
    await select(page, 'todo'); await confirm(page); await expect(trigger(page)).toHaveText(/待处理/); await expectConfirmed(page);
    const reopened = await lifecycle.show(project.id, task.id, 'reopened-after-pending'); expect(reopened).toMatchObject({ status: 'todo', startedAt: null, completedAt: null });
    expect(lifecycle.evidence.writes).toHaveLength(3);
    await screenshot(page, info, 'status-recovered');
  } finally { rejectReadback = false; release.resolve(); await page.unroute(endpoint); await page.unroute(resource); await lifecycle.attach(); await lifecycle.cli.close(); }
});

test('task-status-transitions', { annotation: { type: 'scenario', description: 'task-status-transitions' } }, async ({ page, api, allowStatusWrites }, info) => {
  await pauseAutomaticRefresh(page);
  const lifecycle = await actor(page, info, 'task-status-transitions');
  const project = await createProject(api, { name: 'Nine status assignments and direct dependency protection' });
  const cases: { current: TaskStatus; target: TaskStatus; task: TaskDetail }[] = [];
  for (const current of states) for (const target of states) {
    const created = await createTask(api, project.id, { title: `${current} → ${target}` });
    const initialized = current === 'todo' ? created : await setTaskStatus(api, project.id, created, current);
    cases.push({ current, target, task: await read(api, project.id, initialized.id) });
  }
  allowStatusWrites(cases.map(({ target, task }) => ({ origin: origin(info), projectId: project.id, taskId: task.id, status: target, count: 1 })));
  try {
    for (const { current, target, task } of cases) {
      const endpoint = new URL(`${taskPath(project.id, task.id)}/status`, origin(info)).href;
      await page.route(endpoint, async (route) => { const response = await lifecycle.capture(route, task.id); await fulfillAuthenticatedResponse(route, response); });
      await open(page, project.id, task.id); await select(page, target); await confirm(page);
      await expect(trigger(page)).toBeEnabled(); await expect(trigger(page)).toHaveText(new RegExp(labels['zh-CN'][target])); await expectConfirmed(page);
      const actual = await lifecycle.show(project.id, task.id, `${current}-to-${target}`);
      expect(actual.version).toBe(task.version + (current === target ? 0n : 1n)); expect(invariant(actual)).toEqual(invariant(task));
      if (current === target) expect(actual).toEqual(task);
      else if (target === 'todo') expect(actual).toMatchObject({ startedAt: null, completedAt: null });
      else if (target === 'in_progress') { expect(actual.startedAt).not.toBeNull(); expect(actual.completedAt).toBeNull(); }
      else { expect(actual.startedAt).toBe(current === 'in_progress' ? task.startedAt : null); expect(actual.completedAt).not.toBeNull(); }
      await page.unroute(endpoint);
    }
    for (const external of [false, true]) {
      let prerequisite = await createTask(api, project.id, { title: `${external ? 'external' : 'ordinary'} prerequisite` });
      prerequisite = await setTaskStatus(api, project.id, prerequisite, 'done');
      let dependent = await createTask(api, project.id, { title: 'Direct dependent protects its completed prerequisite', dependsOn: [prerequisite.id] });
      if (external) dependent = await seedExternalDependencies(api, project.id, dependent, [prerequisite.id]);
      dependent = await setTaskStatus(api, project.id, dependent, 'in_progress');
      const refused = await lifecycle.run(['task', 'set-status', prerequisite.id, 'todo', '--project', project.id, '--if-version', String(prerequisite.version)]);
      expect(refused.exitCode).toBe(1); expect(refused.stderr).toContain('dependency_unsatisfied'); expect(refused.stderr).toContain(dependent.id);
      expect(await read(api, project.id, prerequisite.id)).toMatchObject({ status: 'done', version: BigInt(prerequisite.version) });
      dependent = await setTaskStatus(api, project.id, dependent, 'todo');
      await lifecycle.success(['task', 'set-status', prerequisite.id, 'todo', '--project', project.id, '--if-version', String(prerequisite.version)]);
      expect(await read(api, project.id, dependent.id)).toMatchObject({ status: 'todo', ready: false, blockedBy: [prerequisite.id], startedAt: null, completedAt: null });
    }
    const { graph } = await readProjectSnapshot(api, project.id);
    expect(Object.keys(graph.summary).sort()).toEqual(['blocked', 'done', 'inProgress', 'ready', 'todo', 'total']);
    expect(graph.summary.total).toBe(graph.summary.todo + graph.summary.inProgress + graph.summary.done);
    expect(graph.summary.todo).toBe(graph.summary.ready + graph.summary.blocked);
    const rejected = await lifecycle.run(['task', 'set-status', cases[0]!.task.id, 'proposed', '--project', project.id]);
    expect(rejected.exitCode).toBe(2); expect(rejected.stderr).toContain('Unknown status "proposed". Expected todo or in_progress or done.');
    await screenshot(page, info, 'status-nine-transitions');
  } finally { await lifecycle.attach(); await lifecycle.cli.close(); }
});
