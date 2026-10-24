import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Locator, Page, Route, TestInfo } from '@playwright/test';
import { createAcceptanceCli } from '../../scripts/acceptance/installed-cli.mts';
import { parseApiJson, stringifyApiJson } from '../../src/api/json';
import { parseTaskDetail, parseTaskGraph, project as parseProject } from '../../src/api/parse';
import { decodeProjectJson, decodeTaskGraphJson } from '../../src/api/project-json';
import type { TaskDetail } from '../../src/api/types';
import { createProject, createTask, startTask, executeTask, finishTask, expect, seedRunningTaskStart, seedExternalDependencies, test } from './fixtures';
import type { AuthenticatedAPI } from './authentication';
import { expectedChainMembers } from './visible-topology';

const card = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"] .task-node`);
const duration = (scope: Locator): Locator => scope.locator('time.task-duration');
const elapsed = async (scope: Locator): Promise<number> => {
  const value = await duration(scope).getAttribute('datetime');
  const match = /^PT(\d+)\.(\d{3})S$/.exec(value!);
  expect(match, 'Duration exposes precise seconds independently of rounded localized text').not.toBeNull();
  return Number(match![1]) * 1000 + Number(match![2]);
};
const screenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};
const task = async (api: AuthenticatedAPI, projectId: string, taskId: string): Promise<TaskDetail> => {
  const response = await api.get(`/api/v1/projects/${projectId}/tasks/${taskId}`);
  expect(response.status()).toBe(200);
  return parseTaskDetail(parseApiJson(await response.text()), projectId, taskId);
};
const graphGeometry = (page: Page) => page.locator('.task-graph-canvas').evaluate((element) => ({
  nodes: [...element.querySelectorAll('.react-flow__node')].map((node) => ({ id: node.getAttribute('data-id'), transform: (node as HTMLElement).style.transform, width: (node as HTMLElement).style.width, height: (node as HTMLElement).style.height })),
  edges: [...element.querySelectorAll('.react-flow__edge-path')].map((edge) => edge.getAttribute('d')),
  viewport: element.querySelector('.react-flow__viewport')?.getAttribute('style'),
  inspection: [...element.querySelectorAll('.task-node')].map((node) => node.getAttribute('data-inspection')),
}));
const cardLayout = async (scope: Locator): Promise<void> => {
  expect(await scope.evaluate((element) => {
    const outer = element as HTMLElement;
    const bounds = outer.getBoundingClientRect();
    const timing = element.querySelector('time.task-duration')!.getBoundingClientRect();
    const details = element.querySelector('.task-node-details')!.getBoundingClientRect();
    const decorations = [...element.querySelectorAll('.task-stuck-label, .task-agent-permission')];
    return outer.offsetWidth === 220 && [96, 136].includes(outer.offsetHeight)
      && timing.left >= bounds.left && timing.right <= bounds.right && timing.top >= bounds.top && timing.bottom <= bounds.bottom
      && (timing.right <= details.left || timing.bottom <= details.top || timing.top >= details.bottom)
      && decorations.every((item) => { const rect = item.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right && item.scrollWidth <= item.clientWidth; });
  }), 'Timing, warning/automation labels and Details preserve fixed card geometry without overlap').toBe(true);
};
const rowLayout = async (scope: Locator): Promise<void> => {
  expect(await scope.evaluate((element) => {
    const row = element.getBoundingClientRect();
    return row.left >= 0 && row.right <= innerWidth && element.scrollWidth <= element.clientWidth
      && [...element.querySelectorAll('time.task-duration, .task-stuck-label')].every((item) => {
        const rect = item.getBoundingClientRect();
        return rect.left >= row.left && rect.right <= row.right && rect.top >= row.top && rect.bottom <= row.bottom && item.scrollWidth <= item.clientWidth;
      });
  }), 'Standalone timing remains readable inside its narrow row').toBe(true);
};

test.use({ trace: 'off', screenshot: 'off' });
test('task-execution-time', { annotation: { type: 'scenario', description: 'task-execution-time' } }, async ({ page, api, baseURL }, info) => {
  if (baseURL === undefined) throw new Error('Execution-time acceptance requires the actual service origin.');
  const cli = await createAcceptanceCli(baseURL, info.outputPath('installed-cli-execution-time'));
  const evidence = {
    scenario: 'task-execution-time', source: 'tests/e2e/task-execution-time.spec.ts', topology: process.env.DAYNIGHT_ACCEPTANCE_TARGET,
    projectId: '', commands: [] as { argv: readonly string[]; exitCode: number; stdout: string; stderr: string }[],
    tasks: [] as { label: string; value: TaskDetail }[], graphReads: [] as string[],
    progress: [] as string[], failures: [] as { phase: string; name: string; message: string }[],
    timing: {} as Record<string, unknown>, layouts: [] as { locale: string; width: number; kind: string }[],
    controlledConditions: ['Browser Date.now is fixed in 2055 while timers/performance.now and PostgreSQL time advance normally.', 'Owned running-task start timestamps are seeded with a new business version and updatedAt; subsequent task-sync GET deliveries are held during the actual one-second clock threshold crossing.', 'The blocked merge edge to the running prerequisite is explicitly external in the owned database; all dependencies and task timing remain intact.'],
  };
  const success = async (argv: readonly string[]): Promise<string> => {
    const result = await cli.run(argv); evidence.commands.push({ argv, ...result }); expect(result.exitCode).toBe(0); expect(result.stderr).toBe(''); return result.stdout;
  };
  const record = async (projectId: string, taskId: string, label: string) => {
    const value = await task(api, projectId, taskId); evidence.tasks.push({ label, value }); return value;
  };
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const activeRoutes = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let routeRegistered = false;
  const retainFailure = (phase: string, failure: unknown) => {
    if (failures.includes(failure)) return;
    failures.push(failure);
    evidence.failures.push({ phase, name: failure instanceof Error ? failure.name : typeof failure,
      message: failure instanceof Error ? failure.message : String(failure) });
  };
  const holdGraph = (route: Route): Promise<void> => {
    const pending = (async () => { await released; await route.continue(); })();
    activeRoutes.add(pending);
    return pending.catch((failure: unknown) => { retainFailure('held-graph-route', failure); throw failure; })
      .finally(() => { activeRoutes.delete(pending); });
  };
  const drainGraph = async (): Promise<void> => {
    release();
    // Routing remains enabled until every held request has completed its continuation.
    await Promise.all([...activeRoutes]);
    if (routeRegistered) {
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' });
      routeRegistered = false;
    }
  };
  let delivered = 0;
  try {
    const project = await createProject(api, { name: `Execution time ${randomUUID()}` }); evidence.projectId = project.id;
    const roots = [
      await createTask(api, project.id, { title: 'Completed prerequisite A' }),
      await createTask(api, project.id, { title: 'Completed prerequisite B' }),
    ];
    for (const root of roots) await executeTask(api, project.id, root);
    const external = await startTask(api, project.id, await createTask(api, project.id, { title: 'Overdue external prerequisite' }));
    const blockedMerge = await createTask(api, project.id, { title: 'Blocked merge exposes the external running prerequisite', dependsOn: [roots[1]!.id, external.id] });
    await seedExternalDependencies(api, project.id, blockedMerge, [external.id]);
    const classifiedMerge = await record(project.id, blockedMerge.id, 'blocked-merge-external-classification');
    expect(classifiedMerge.externalDependsOn).toEqual([external.id]);
    const crossing = await startTask(api, project.id, await createTask(api, project.id, { title: 'Current attempt crosses the saved threshold', dependsOn: roots.map(({ id }) => id) }));
    await createTask(api, project.id, { title: 'Keeps completed timing visible in the active chain', dependsOn: [crossing.id] });
    const multiParent = await startTask(api, project.id, await createTask(api, project.id, { title: 'Long multi-parent multi-day execution title '.repeat(7), dependsOn: roots.map(({ id }) => id) }));
    const brief = await createTask(api, project.id, { title: 'Known sub-minute completed task', dependsOn: [roots[1]!.id] });
    await executeTask(api, project.id, brief);
    const standalone = await startTask(api, project.id, await createTask(api, project.id, { title: 'Long standalone multi-day execution '.repeat(6) }));
    const legacy = await startTask(api, project.id, await createTask(api, project.id, { title: 'Historical unknown execution start' }));
    const briefRow = await createTask(api, project.id, { title: 'Known sub-minute standalone completion' });
    await executeTask(api, project.id, briefRow);
    await seedRunningTaskStart(project.id, external.id, 2 * 86_400_000);
    await seedRunningTaskStart(project.id, multiParent.id, 3 * 86_400_000 + 17 * 60_000);
    await seedRunningTaskStart(project.id, standalone.id, 4 * 86_400_000 + 25 * 60_000);
    const legacyBefore = await record(project.id, legacy.id, 'legacy-before-seed');
    await seedRunningTaskStart(project.id, legacy.id, null);
    const legacyUnknown = await record(project.id, legacy.id, 'legacy-unknown-start');
    expect(legacyUnknown).toEqual({ ...legacyBefore, startedAt: null, version: legacyBefore.version + 1n, updatedAt: legacyUnknown.updatedAt });
    expect(legacyUnknown.updatedAt).not.toBe(legacyBefore.updatedAt);
    const settings = async (minutes: number) => {
      const currentResponse = await api.get(`/api/v1/projects/${project.id}`); expect(currentResponse.status()).toBe(200);
      const current = parseProject(await decodeProjectJson(new Response(await currentResponse.text())));
      const response = await api.patch(`/api/v1/projects/${project.id}/settings`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: current.settings.version, executionWarningMinutes: minutes }) });
      expect(response.status()).toBe(200);
      const saved = parseProject(await decodeProjectJson(new Response(await response.text())));
      expect(saved.settings.executionWarningMinutes).toBe(minutes); return saved;
    };
    await page.clock.setFixedTime(new Date('2055-01-01T00:00:00Z'));
    const syncPath = `/api/v1/projects/${project.id}/task-sync`;
    page.on('response', (response) => { if (new URL(response.url()).pathname === syncPath) delivered += 1; });
    await page.goto(`/projects/${project.id}`);
    const openTimingChain = async () => {
      const toggle = page.locator(`#task-root-${roots[0]!.id}`);
      await expect(toggle).toBeVisible();
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.task-graph-canvas')).toHaveCount(1);
      await expect(page.locator(`#task-graph-${roots[0]!.id}`)).toBeVisible();
    };
    await openTimingChain();
    const claimed = await record(project.id, crossing.id, 'crossing-before-seed');
    await seedRunningTaskStart(project.id, crossing.id, 3_585_000);
    const seeded = await record(project.id, crossing.id, 'crossing-seeded-business-transition');
    expect(seeded).toEqual({ ...claimed, startedAt: seeded.startedAt, version: claimed.version + 1n, updatedAt: seeded.updatedAt });
    expect(seeded.startedAt).not.toBe(claimed.startedAt); expect(seeded.updatedAt).not.toBe(claimed.updatedAt);
    await page.reload();
    const ticking = card(page, crossing.id);
    await expect(duration(ticking)).toBeVisible();
    await expect(ticking.locator('.task-stuck-label')).toHaveCount(0);
    const initial = await elapsed(ticking); expect(initial).toBeLessThan(3_600_000); expect(initial).toBeGreaterThan(3_580_000);
    expect(await page.evaluate(() => Date.now())).toBe(new Date('2055-01-01T00:00:00Z').getTime());
    evidence.progress.push('fresh-below-threshold-snapshot');
    await page.route((url) => url.pathname === syncPath, holdGraph); routeRegistered = true;
    const deliveredBefore = delivered;
    const inspection = ticking.locator('.task-node-body'); const details = ticking.locator('.task-node-details');
    await inspection.click(); await details.focus();
    const retained = await details.elementHandle(); if (retained === null) throw new Error('The focused Details control is missing.');
    const beforeGeometry = await graphGeometry(page);
    const began = performance.now();
    await expect.poll(() => elapsed(ticking), { timeout: 5_000 }).toBeGreaterThan(initial + 1000);
    await expect(ticking.locator('.task-stuck-label')).toHaveText('可能卡住了', { timeout: 25_000 });
    const crossed = await elapsed(ticking); expect(crossed).toBeGreaterThan(3_600_000);
    expect(delivered, 'Warning crosses without a new graph response').toBe(deliveredBefore);
    expect(await graphGeometry(page)).toEqual(beforeGeometry); await expect(details).toBeFocused();
    expect(await retained.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
    expect(await duration(ticking).evaluate((element) => element.closest('[aria-live]'))).toBeNull();
    evidence.timing = { initial, crossed, realCrossingWaitMs: performance.now() - began, deliveredBefore, deliveredAtCrossing: delivered, wrongClientWallTime: '2055-01-01T00:00:00Z', geometryPreserved: true, focusedDetailsPreserved: true };
    await screenshot(page, info, 'execution-real-threshold-crossing');
    evidence.progress.push('real-threshold-crossing-with-stable-focus-and-geometry');
    await drainGraph(); evidence.progress.push('held-graph-routes-drained');
    await expect.poll(() => delivered, { timeout: 10_000 }).toBeGreaterThan(deliveredBefore);
    const running = await record(project.id, crossing.id, 'running-after-crossing');
    expect(running).toEqual(seeded);
    const cliTask = parseTaskDetail(parseApiJson(await success(['task', 'show', crossing.id, '--project', project.id, '--json'])), project.id, crossing.id);
    expect(cliTask).toEqual(running);
    const rawGraph = await success(['task', 'graph', '--project', project.id, '--json']); evidence.graphReads.push(rawGraph);
    const graph = parseTaskGraph(await decodeTaskGraphJson(new Response(rawGraph)), project.id);
    const members = expectedChainMembers(graph.tasks, roots[0]!.id);
    expect(members).toHaveLength(7);
    expect(members).toEqual(expect.arrayContaining([roots[0]!.id, roots[1]!.id, crossing.id, multiParent.id, blockedMerge.id, brief.id]));
    expect(members).not.toContain(external.id);
    evidence.timing.ordinaryComponentMembers = members;
    evidence.timing.externalContextTask = external.id;
    expect(graph.tasks.find(({ id }) => id === crossing.id)!.startedAt).toBe(running.startedAt);
    expect(Date.parse(graph.observedAt)).toBeLessThan(new Date('2055-01-01T00:00:00Z').getTime());

    await settings(90); await expect(ticking.locator('.task-stuck-label')).toHaveCount(0, { timeout: 10_000 });
    expect(await graphGeometry(page)).toEqual(beforeGeometry); await expect(details).toBeFocused();
    expect((await record(project.id, crossing.id, 'higher-threshold-preserves-start')).startedAt).toBe(running.startedAt);
    await settings(60); await expect(ticking.locator('.task-stuck-label')).toHaveText('可能卡住了', { timeout: 10_000 });
    expect((await record(project.id, crossing.id, 'lower-threshold-preserves-start')).startedAt).toBe(running.startedAt);
    await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    const unknownRunning = page.locator(`#standalone-task-${legacy.id}`);
    await expect(unknownRunning).toContainText('进行中');
    await expect(duration(unknownRunning)).toHaveCount(0); await expect(unknownRunning.locator('.task-stuck-label')).toHaveCount(0);
    await page.getByRole('tab', { name: '任务链', exact: true }).click();
    await success(['task', 'set-status', crossing.id, 'done', '--project', project.id, '--if-version', String(running.version)]);
    const completed = await record(project.id, crossing.id, 'completed-freeze');
    expect(completed.startedAt).toBe(running.startedAt); expect(completed.completedAt).not.toBeNull();
    await expect(ticking.locator('.graph-status')).toHaveText('已完成', { timeout: 10_000 });
    await expect(ticking.locator('.task-stuck-label')).toHaveCount(0);
    const frozen = await duration(ticking).getAttribute('datetime');
    expect(await elapsed(ticking)).toBe(Date.parse(completed.completedAt!) - Date.parse(completed.startedAt!));
    const freezeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === syncPath);
    await freezeResponse; expect(await duration(ticking).getAttribute('datetime')).toBe(frozen);
    evidence.timing.completedDuration = frozen; evidence.progress.push('completed-duration-frozen-across-poll');
    await finishTask(api, project.id, legacy);
    const completedLegacy = await record(project.id, legacy.id, 'completed-legacy-remains-unknown');
    expect(completedLegacy.startedAt).toBeNull(); expect(completedLegacy.completedAt).not.toBeNull();
    await retained.dispose();
    await openTimingChain();

    for (const locale of ['zh-CN', 'en'] as const) {
      await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链', exact: true }).click();
      await openTimingChain();
      await expect(page.locator('.root-toggle')).toHaveCount(1);
      await expect(card(page, multiParent.id)).toHaveCount(1);
      await expect(card(page, roots[0]!.id)).toHaveCount(1);
      await expect(card(page, roots[1]!.id)).toHaveCount(1);
      await expect(page.locator('.task-node-external')).toHaveCount(1);
      await expect(card(page, multiParent.id).locator('.task-stuck-label')).toHaveText(locale === 'en' ? 'Possibly stuck' : '可能卡住了');
      await expect(duration(card(page, brief.id))).toContainText(locale === 'en' ? '< 1 min' : '不足 1 分钟');
      expect(await page.locator('.root-toggle time.task-duration').count(), 'Chain summaries have no individual task duration').toBe(0);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await cardLayout(card(page, multiParent.id)); await cardLayout(ticking); await cardLayout(card(page, brief.id)); await cardLayout(card(page, external.id));
        await expect(card(page, external.id)).toHaveClass(/task-node-external/);
        await expect(card(page, external.id)).toHaveClass(/task-node-stuck/);
        expect(await card(page, external.id).evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('dashed');
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        evidence.layouts.push({ locale, width, kind: 'graph' }); await screenshot(page, info, `execution-graph-${locale}-${width}`);
      }
      await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务', exact: true }).click();
      const showCompleted = page.locator('.completed-chain-control input'); await showCompleted.check();
      const row = page.locator(`#standalone-task-${standalone.id}`);
      await expect(row.locator('.task-stuck-label')).toHaveText(locale === 'en' ? 'Possibly stuck' : '可能卡住了');
      const unknown = page.locator(`#standalone-task-${legacy.id}`); await expect(unknown).toBeVisible(); await expect(unknown.locator('.root-status')).toHaveText(locale === 'en' ? 'Done' : '已完成'); await expect(duration(unknown)).toHaveCount(0); await expect(unknown.locator('.task-stuck-label')).toHaveCount(0);
      await expect(duration(page.locator(`#standalone-task-${briefRow.id}`))).toContainText(locale === 'en' ? '< 1 min' : '不足 1 分钟');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 1000 }); await rowLayout(row); await rowLayout(unknown);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        evidence.layouts.push({ locale, width, kind: 'standalone' }); await screenshot(page, info, `execution-standalone-${locale}-${width}`);
      }
    }
    await page.reload(); await expect(page.locator(`#standalone-task-${legacy.id}`)).toBeVisible(); await expect(duration(page.locator(`#standalone-task-${legacy.id}`))).toHaveCount(0);
    const final = parseTaskDetail(parseApiJson(await success(['task', 'show', crossing.id, '--project', project.id, '--json'])), project.id, crossing.id);
    expect(final.startedAt).toBe(completed.startedAt); expect(final.completedAt).toBe(completed.completedAt);
    evidence.progress.push('bilingual-narrow-presentation-and-reload-verified');
  } catch (failure) { retainFailure('scenario', failure); }
  finally {
    try { await drainGraph(); } catch (failure) { retainFailure('graph-route-cleanup', failure); }
    try { await cli.close(); } catch (failure) { retainFailure('installed-cli-cleanup', failure); }
    try {
      const path = info.outputPath('task-execution-time-receipt.json');
      await writeFile(path, `${JSON.stringify(evidence, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`);
      await info.attach('task-execution-time-receipt', { path, contentType: 'application/json' });
    } catch (failure) { retainFailure('receipt', failure); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Execution-time scenario and cleanup failed.');
});
