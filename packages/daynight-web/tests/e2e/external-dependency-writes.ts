import { closeChain, openChain as openChainDialog } from './chain-dialog';
import { selectOverview, selectTaskList } from './project-view';
import { readFile, writeFile } from 'node:fs/promises';
import type { Page, Request, TestInfo } from '@playwright/test';
import { createAcceptanceCli } from '../../scripts/acceptance/installed-cli.mts';
import { parseApiJson, stringifyApiJson } from '../../src/api/json';
import { parseTaskDetail, parseTaskGraph } from '../../src/api/parse';
import { decodeTaskGraphJson } from '../../src/api/project-json';
import type { TaskDetail } from '../../src/api/types';
import type { AuthenticatedAPI } from './authentication';
import { createProject, expect } from './fixtures';
import { checkDependencyGeometry, expectedDependencyTopology } from './dependency-geometry';

const taskPath = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}`;
const detail = (page: Page) => page.locator('.task-detail-dialog');
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const resourceId = (output: string): string => {
  const matches = [...output.matchAll(/^ID: ([0-9a-f-]{36})$/gm)];
  expect(matches, 'Installed creation identifies exactly one task').toHaveLength(1);
  return matches[0]![1]!;
};
const relationOnly = (before: TaskDetail, after: TaskDetail, dependencies: readonly string[], external: readonly string[]): void => {
  const changed = JSON.stringify(before.dependsOn) !== JSON.stringify([...dependencies].sort())
    || JSON.stringify(before.externalDependsOn) !== JSON.stringify([...external].sort());
  expect(after, 'Dependency classification preserves all other task fields, permissions and execution timing').toEqual({
    ...before, dependsOn: [...dependencies].sort(), externalDependsOn: [...external].sort(),
    version: before.version + BigInt(changed), updatedAt: after.updatedAt,
  });
  if (changed) expect(after.updatedAt).not.toBe(before.updatedAt); else expect(after.updatedAt).toBe(before.updatedAt);
};

export const verifyPublicExternalDependencyWrites = async (page: Page, api: AuthenticatedAPI, baseURL: string, info: TestInfo): Promise<void> => {
  const receiptPath = process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT;
  if (receiptPath === undefined) throw new Error('External dependency writes require the validated installed CLI receipt.');
  const installedCli: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
  const cli = await createAcceptanceCli(baseURL, info.outputPath('installed-cli-external-dependencies'));
  const evidence = {
    scenario: 'project-graph', operation: 'public-external-dependency-writes', origin: baseURL, installedCli,
    commands: [] as { argv: readonly string[]; exitCode: number; stdout: string; stderr: string }[],
    mutations: [] as { path: string; body: string; status: number; response: string; requestId: string | null }[],
    tasks: [] as { label: string; task: TaskDetail }[],
    webSyncs: [] as { url: string; body: string }[],
    graphOracles: [] as { origin: string; body: string }[],
    steps: [] as string[], failures: [] as string[],
  };
  let failure: unknown;
  const run = async (argv: readonly string[]) => { const result = await cli.run(argv); evidence.commands.push({ argv, ...result }); return result; };
  const success = async (argv: readonly string[]) => {
    const result = await run(argv); expect(result.exitCode, `Installed CLI succeeds: ${argv.join(' ')}`).toBe(0); expect(result.stderr).toBe(''); return result.stdout;
  };
  try {
    const project = await createProject(api, { name: 'Public external dependency writes' });
    const read = async (id: string, label: string): Promise<TaskDetail> => {
      const response = await api.get(taskPath(project.id, id)); expect(response.status()).toBe(200);
      const task = parseTaskDetail(parseApiJson(await response.text()), project.id, id); evidence.tasks.push({ label, task }); return task;
    };
    const cliRead = async (id: string, label: string): Promise<TaskDetail> => {
      const task = parseTaskDetail(parseApiJson(await success(['task', 'show', id, '--project', project.id, '--json'])), project.id, id);
      expect(task, 'Installed CLI and API read the same full task').toEqual(await read(id, label)); return task;
    };
    const action = async (task: TaskDetail, status: TaskDetail['status']): Promise<TaskDetail> => {
      await success(['task', 'set-status', task.id, status, '--project', project.id, '--if-version', String(task.version)]);
      const after = await read(task.id, `cli-${status}`);
      expect(after.version).toBe(task.version + 1n);
      expect(after.dependsOn).toEqual(task.dependsOn); expect(after.externalDependsOn).toEqual(task.externalDependsOn);
      return after;
    };
    const create = async (title: string, options: readonly string[] = []): Promise<TaskDetail> => {
      const id = resourceId(await success(['task', 'create', '--project', project.id, '--title', title, ...options]));
      return cliRead(id, 'cli-created');
    };
    const complete = async (task: TaskDetail) => action(await action(task, 'in_progress'), 'done');
    const patchFlags = async (task: TaskDetail, external: readonly string[], status = 200, version = task.version): Promise<TaskDetail> => {
      const path = taskPath(project.id, task.id); const body = stringifyApiJson({ version, externalDependsOn: external });
      const response = await api.patch(path, { headers: { 'Content-Type': 'application/json' }, data: body });
      const raw = await response.text(); const requestId = response.headers()['x-request-id'] ?? null;
      evidence.mutations.push({ path, body, status: response.status(), response: raw, requestId });
      expect(response.status()).toBe(status); expect(requestId).toMatch(requestIdPattern);
      if (status !== 200) {
        const refusal = JSON.parse(raw) as { error: { code: string; requestId: string } };
        expect(refusal.error.code).toBe(status === 409 ? 'version_conflict' : 'invalid_input');
        expect(refusal.error.requestId, 'Public refusal body and response header share the same opaque correlation ID').toBe(requestId);
        expect(await read(task.id, 'refused-public-patch')).toEqual(task); return task;
      }
      const after = parseTaskDetail(parseApiJson(raw), project.id, task.id);
      relationOnly(task, after, task.dependsOn, external); expect(after).toEqual(await read(task.id, 'flags-only-patch')); return after;
    };
    const syncPath = `/api/v1/projects/${project.id}/task-sync`;
    const readWeb = async (navigate = false) => {
      if (!navigate) { await closeChain(page); await selectOverview(page); }
      const requests = new Set<Request>();
      const capture = (request: Request) => {
        const url = new URL(request.url());
        if (url.origin === baseURL && url.pathname === syncPath && request.method() === 'GET') requests.add(request);
      };
      page.on('request', capture);
      try {
        const [response] = await Promise.all([
          page.waitForResponse((response) => requests.has(response.request())),
          navigate ? page.goto(`/projects/${project.id}`) : page.getByRole('button', { name: '刷新', exact: true }).click(),
        ]);
        expect(response.status()).toBe(200); expect(new URL(response.url()).origin).toBe(baseURL);
        const body = await response.text(); evidence.webSyncs.push({ url: response.url(), body });
        const graphResponse = await api.get(`/api/v1/projects/${project.id}/task-graph`);
        expect(graphResponse.status()).toBe(200);
        const graphBody = await graphResponse.text();
        evidence.graphOracles.push({ origin: baseURL, body: graphBody });
        const graph = parseTaskGraph(await decodeTaskGraphJson(new Response(graphBody)), project.id);
        const count = new Intl.NumberFormat('zh-CN');
        for (const [label, value] of [
          ['任务总数', graph.summary.total], ['待处理', graph.summary.todo], ['进行中', graph.summary.inProgress],
          ['已完成', graph.summary.done], ['可开始', graph.summary.ready], ['被阻塞', graph.summary.blocked],
        ] as const) {
          await expect(page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-number')).toHaveText(count.format(value));
        }
        return graph;
      } finally { page.off('request', capture); }
    };
    const openChain = async (representative: string) => {
      await selectTaskList(page);
      await page.getByRole('tab', { name: '任务链', exact: true }).click();
      await openChainDialog(page, representative);
      return page.locator(`#task-root-${representative}`);
    };

    const ordinary = await complete(await create('普通链交付起点'));
    const externalRoot = await complete(await create('外部链交付起点'));
    let external = await create('外部链尚未完成的成果', ['--depends-on', externalRoot.id]);
    let consumer = await create('由 CLI 声明混合依赖的任务', [
      '--description', '公开创建和分类更新应保留任务状态、执行时间与关联资料。',
      '--depends-on', ordinary.id, '--external-depends-on', external.id,
      '--pull-request-url', 'https://example.com/pull/42', '--pull-request-title', 'Preserved public dependency contract',
    ]);
    expect(consumer.dependsOn).toEqual([ordinary.id, external.id].sort()); expect(consumer.externalDependsOn).toEqual([external.id]);
    expect(consumer.status).toBe('todo'); expect(consumer.startedAt).toBeNull(); expect(consumer.completedAt).toBeNull();
    const listed = JSON.parse(await success(['task', 'list', '--project', project.id, '--all', '--json'])) as { id: string; externalDependsOn: string[]; description?: string }[];
    const listedConsumer = listed.find(({ id }) => id === consumer.id)!;
    expect(listedConsumer.externalDependsOn).toEqual([external.id]); expect(Object.hasOwn(listedConsumer, 'description')).toBe(false);
    const initial = await readWeb(true); await openChain(ordinary.id);
    expect(expectedDependencyTopology(initial.tasks, ordinary.id).memberIds).toHaveLength(2);
    await expect(page.locator('.task-node-external')).toHaveCount(2);
    await expect(page.locator(`.task-dependency-edge[data-id="${externalRoot.id}->${external.id}"]`)).toHaveAttribute('data-external', 'false');
    await expect(page.locator(`.task-dependency-edge[data-id="${external.id}->${consumer.id}"]`)).toHaveAttribute('data-external', 'true');
    await page.locator(`.react-flow__node[data-id="${consumer.id}"] .task-node-details`).click();
    const predecessors = detail(page).getByRole('region', { name: '前置依赖', exact: true });
    await expect(predecessors.getByRole('button', { name: `${ordinary.title}，普通依赖`, exact: true })).toBeVisible();
    await expect(predecessors.getByRole('button', { name: `${external.title}，外部依赖`, exact: true })).toBeVisible();
    await expect(detail(page).getByRole('region', { name: '当前未完成的前置', exact: true }).locator('.task-detail-relation-external')).toHaveCount(1);
    await page.keyboard.press('Escape'); evidence.steps.push('installed-cli-create-api-and-web-readback');

    const blocked = await run(['task', 'set-status', consumer.id, 'in_progress', '--project', project.id, '--if-version', String(consumer.version)]);
    expect(blocked.exitCode).toBe(1); expect(blocked.stderr).toContain('dependency_unsatisfied'); expect(blocked.stderr).toContain(external.id);
    const statusRequestIds = [...blocked.stderr.matchAll(/\(requestId=([^)]*)\)/g)];
    expect(statusRequestIds, 'Installed refusal retains one complete server correlation ID').toHaveLength(1);
    expect(statusRequestIds[0]![1]).toMatch(requestIdPattern);
    expect(await read(consumer.id, 'external-status-refusal')).toEqual(consumer);
    const ready = JSON.parse(await success(['task', 'ready', '--project', project.id, '--json'])) as { id: string; externalDependsOn: string[] }[];
    expect(ready.some(({ id }) => id === consumer.id)).toBe(false); expect(ready.find(({ id }) => id === external.id)!.externalDependsOn).toEqual([]);
    await success(['task', 'update', consumer.id, '--project', project.id, '--if-version', String(consumer.version), '--description', '仅修改描述，完整依赖及外部标识保持。']);
    const edited = await cliRead(consumer.id, 'omitted-dependency-fields');
    expect(edited).toEqual({ ...consumer, description: '仅修改描述，完整依赖及外部标识保持。', version: consumer.version + 1n, updatedAt: edited.updatedAt }); consumer = edited;
    external = await action(await action(external, 'in_progress'), 'done');
    const unblocked = await read(consumer.id, 'external-completion-derived-readiness');
    expect(unblocked).toEqual({ ...consumer, blockedBy: [], ready: true }); consumer = unblocked;
    consumer = await action(consumer, 'in_progress'); expect(consumer.startedAt).not.toBeNull(); expect(consumer.completedAt).toBeNull();
    evidence.steps.push('external-execution-prerequisite-and-lifecycle-preserved');

    const runningStart = consumer.startedAt;
    consumer = await patchFlags(consumer, []);
    const merged = await readWeb(); await openChain(ordinary.id);
    expect(expectedDependencyTopology(merged.tasks, ordinary.id).memberIds).toHaveLength(4);
    await expect(page.locator('.root-toggle')).toHaveCount(1); await expect(page.locator('.task-node-external')).toHaveCount(0);
    await expect(page.locator(`#task-root-${ordinary.id} .root-progress-label`)).toHaveText('3/4 已完成');
    consumer = await patchFlags(consumer, [external.id]);
    const split = await readWeb(); await openChain(ordinary.id);
    const expected = expectedDependencyTopology(split.tasks, ordinary.id); expect(expected.memberIds).toHaveLength(2); expect(expected.nodes).toHaveLength(4);
    await expect(page.locator('.task-node-external')).toHaveCount(2);
    await expect(page.locator(`#task-root-${ordinary.id} .root-progress-label`)).toHaveText('1/2 已完成');
    expect(await checkDependencyGeometry(page, expected, info)).toEqual({ total: 0, examples: [] });
    await page.locator(`.react-flow__node[data-id="${consumer.id}"] .task-node-details`).click();
    await expect(detail(page).getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${external.title}，外部依赖`, exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); evidence.steps.push('public-flags-only-merge-split-and-label-refresh');

    const replace = async (options: readonly string[], dependencies: readonly string[], externalIds: readonly string[], label: string) => {
      const before = consumer; await success(['task', 'update', consumer.id, '--project', project.id, '--if-version', String(consumer.version), ...options]);
      consumer = await cliRead(consumer.id, label); relationOnly(before, consumer, dependencies, externalIds);
    };
    await replace(['--external-depends-on', external.id], [external.id], [external.id], 'cli-external-only-replacement');
    await readWeb(); await selectTaskList(page); await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    await expect(page.locator(`#standalone-task-${consumer.id}`)).toBeVisible();
    await replace(['--depends-on', external.id], [external.id], [], 'cli-normal-only-clears-classification');
    const ordinaryGraph = await readWeb(); await openChain(externalRoot.id);
    expect(expectedDependencyTopology(ordinaryGraph.tasks, externalRoot.id).memberIds).toHaveLength(3);
    await expect(page.locator('.task-node-external')).toHaveCount(0);
    await expect(page.locator(`.task-dependency-edge[data-id="${external.id}->${consumer.id}"]`)).toHaveAttribute('data-external', 'false');
    await replace(['--clear-dependencies'], [], [], 'cli-clear-both-dependency-sets');
    await readWeb(); await selectTaskList(page); await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    await expect(page.locator(`#standalone-task-${consumer.id}`)).toBeVisible(); expect(consumer.startedAt).toBe(runningStart);
    const beforeCompletion = consumer; consumer = await action(consumer, 'done'); expect(consumer.startedAt).toBe(runningStart); expect(consumer.completedAt).not.toBeNull();
    await patchFlags(consumer, []); await patchFlags(consumer, [], 409, beforeCompletion.version); await patchFlags(consumer, [ordinary.id], 400);
    await readWeb();
    await selectTaskList(page);
    await page.getByRole('checkbox', { name: /显示所有/ }).check();
    const completedRow = page.locator(`#standalone-task-${consumer.id}`);
    await expect(completedRow.locator('.root-status')).toHaveText('已完成');
    await expect(completedRow.locator('time.task-duration')).toHaveAttribute('datetime', /^PT\d+\.\d{3}S$/);
    evidence.steps.push('installed-replacements-clear-noop-stale-and-invalid-subset');
    const image = info.outputPath('public-external-dependency-writes.png'); await page.screenshot({ path: image, fullPage: true });
    await info.attach('public-external-dependency-writes', { path: image, contentType: 'image/png' });
  } catch (error) { failure = error; evidence.failures.push(error instanceof Error ? error.message : String(error)); }
  finally {
    try { await cli.close(); } catch (error) { evidence.failures.push(error instanceof Error ? error.message : String(error)); failure = failure === undefined ? error : new AggregateError([failure, error], 'Public dependency acceptance and CLI cleanup failed.'); }
    try {
      const body = JSON.stringify(evidence, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2);
      const path = info.outputPath('public-external-dependency-writes.json'); await writeFile(path, `${body}\n`);
      await info.attach('public-external-dependency-write-receipts', { path, contentType: 'application/json' });
    } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Public dependency acceptance receipt failed.'); }
  }
  if (failure !== undefined) throw failure;
};
