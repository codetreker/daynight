import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId, workerPage, workerSummary } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

// The browser runs the production app with a controlled HTTP API. The tabs share
// Chromium's real IndexedDB and BroadcastChannel; this does not exercise a live service.
const personalId = '00000000-0000-4000-8000-000000000701';
const privateId = workerId(301), healthyId = workerId(302), taskId = workerId(201), worker = workerId(1);
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const project = (id: string, name: string) => ({ id, name, repoUrl: `https://example.test/${name.replaceAll(' ', '-')}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: personalId, version: 1n }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME });
const privateProject = project(privateId, 'Private Project'), healthyProject = project(healthyId, 'Healthy Project');
const task = detailFixture(privateId, taskId, { title: 'Private task' });
const graph = { ...graphFixture([task]), project: privateProject };
const access = directAccessFixture(privateId, WORKER_USER);
const error = { error: { code: 'not_found', message: 'not found', requestId: 'fixture' } };
const freshDetail = (revoked: boolean) => {
  const detail = workerDetail();
  const privateTask = { ...detail.worker.tasks[0]!, projectId: privateId, title: 'Private worker task', projectName: 'Private Project' };
  const healthyTask = { ...privateTask, projectId: healthyId, taskId: workerId(202), title: 'Healthy worker task', projectName: 'Healthy Project' };
  detail.worker.tasks = revoked ? [healthyTask] : [privateTask, healthyTask]; detail.worker.activeTaskCount = detail.worker.tasks.length;
  return detail;
};
const summary = (revoked: boolean) => ({ ...workerSummary(), taskObservationState: 'observed' as const, taskObservedAt: WORKER_TIME, activeTaskCount: revoked ? 1 : 2 });
const configuration = configurationResource('1', { ...configurationValue(), projects: [privateId, healthyId].map(projectId => ({ projectId, nativeOverrides: {} })) });
type Gate = { promise: Promise<void>; release: () => void; started: boolean; finished: boolean };
const gate = (): Gate => { const pending = Promise.withResolvers<void>(); return { promise: pending.promise, release: pending.resolve, started: false, finished: false }; };
const wait = async (gate: Gate) => { gate.started = true; await gate.promise; };

const install = async (context: BrowserContext, pages: { directory?: Page; detail?: Page; worker?: Page; list?: Page }) => {
  const state = { revoked: false, denials: 0, page: null as Gate | null, metadata: null as Gate | null, worker: null as Gate | null, list: null as Gate | null, rereadList: null as Gate | null };
  await context.addInitScript(() => {
    localStorage.setItem('daynight.web.locale', 'en');
    // Keep polling active in headless tabs while preserving real cross-tab storage.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
  await context.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, owner = request.frame().page();
    const revoked = state.revoked;
    const send = async (value: unknown, status = 200, extra: Record<string, string> = {}, gated: Gate | null = null) => {
      try { await route.fulfill({ status, contentType: 'application/json', headers: { 'Daynight-User-ID': WORKER_USER, ...extra }, body: stringifyWireJson(value) }); }
      catch (error) { if (request.failure() === null && !owner.isClosed()) throw error; }
      finally { if (gated !== null) gated.finished = true; }
    };
    if (path === '/api/v1/me') return send(profile);
    const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: WORKER_USER, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') {
      const pageGate = owner === pages.directory && url.searchParams.get('cursor') === 'more' ? state.page : null;
      const metadataGate = owner === pages.worker && url.searchParams.get('limit') === '100' ? state.metadata : null;
      if (pageGate !== null) { state.page = null; await wait(pageGate); }
      if (metadataGate !== null) { state.metadata = null; await wait(metadataGate); }
      const items = revoked ? [healthyProject] : [privateProject, healthyProject];
      return send({ items, nextCursor: owner === pages.directory && url.searchParams.get('cursor') === null && url.searchParams.get('limit') === '50' ? 'more' : null }, 200, {}, pageGate ?? metadataGate);
    }
    if (path === `/api/v1/projects/${privateId}/access`) return revoked ? send(error, 404) : send(access);
    if (path === `/api/v1/projects/${privateId}/task-sync`) {
      if (revoked) { state.denials++; return send(error, 404); }
      return send(taskSyncFixture(graph, { actorAccess: access, query: taskSyncQuery(url), versionForTask: () => 1n, propertiesForTask: () => task.properties }));
    }
    if (path === `/api/v1/projects/${privateId}`) return revoked ? send(error, 404) : send(privateProject);
    if (path === `/api/v1/projects/${privateId}/tasks/${taskId}`) return revoked ? send(error, 404) : send(task);
    if (path === '/api/v1/me/workers') {
      const hold = owner === pages.list ? revoked ? state.rereadList : state.list : null;
      if (hold !== null) { if (revoked) state.rereadList = null; else state.list = null; await wait(hold); }
      return send(workerPage([summary(revoked)]), 200, {}, hold);
    }
    if (path === `/api/v1/me/workers/${worker}`) {
      const hold = owner === pages.worker ? state.worker : null;
      if (hold !== null) { state.worker = null; await wait(hold); }
      return send(freshDetail(revoked), 200, {}, hold);
    }
    if (path === `/api/v1/me/workers/${worker}/configuration`) return send(configuration, 200, { 'Daynight-Worker-Configuration': '1' });
    if (path.endsWith('/sessions') || path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    return send(error, 404);
  });
  return state;
};

test('withdraws shared projections and fences late reads, then restores fresh access', async ({ context }, testInfo) => {
  const pages: { directory?: Page; detail?: Page; worker?: Page; list?: Page } = {};
  const state = await install(context, pages);
  const pending: Gate[] = [];
  const hold = () => { const value = gate(); pending.push(value); return value; };
  try {
    pages.detail = await context.newPage(); await pages.detail.goto(`/projects/${privateId}`);
    await pages.detail.getByRole('tab', { name: 'Task list' }).click();
    await pages.detail.getByRole('tab', { name: 'Standalone tasks' }).click();
    await expect(pages.detail.getByText('Private task', { exact: true }).first()).toBeVisible();
    await expect.poll(() => pages.detail!.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'daynight-task-cache'))).toBe(true);
    pages.directory = await context.newPage(); await pages.directory.goto('/projects');
    await expect(pages.directory.getByRole('heading', { name: 'Private Project', exact: true })).toBeVisible();
    const healthy = pages.directory.getByRole('heading', { name: 'Healthy Project', exact: true }).locator('xpath=ancestor::a');
    await healthy.focus();
    pages.list = await context.newPage(); await pages.list.goto('/workers');
    const card = pages.list.locator('.worker-card'); await expect(card).toContainText('2 tasks in progress');
    pages.worker = await context.newPage(); await pages.worker.goto(`/workers/${worker}`);
    await expect(pages.worker.getByText('Private worker task', { exact: true })).toBeVisible();
    await expect(pages.worker.getByText('Healthy worker task', { exact: true })).toBeVisible();
    const oldWorker = hold(); state.worker = oldWorker;
    await pages.worker.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect.poll(() => oldWorker.started).toBe(true);
    await pages.worker.locator('#worker-tab-configuration').click();
    const draft = pages.worker.locator('#config-native-args'); await draft.fill('[invalid draft');
    await expect(pages.worker.getByRole('heading', { name: 'Private Project', exact: true })).toBeVisible();
    await expect(pages.worker.getByRole('heading', { name: 'Healthy Project', exact: true })).toBeVisible();
    const oldMetadata = hold(); state.metadata = oldMetadata;
    await pages.worker.getByRole('button', { name: /Choose projects/ }).first().click();
    const dialog = pages.worker.getByRole('dialog'), search = pages.worker.locator('#configuration-project-search');
    await expect.poll(() => oldMetadata.started).toBe(true); await search.fill('000001');
    await search.evaluate((input: HTMLInputElement) => { input.focus(); input.setSelectionRange(1, 4); });
    const oldPage = hold(); state.page = oldPage;
    await pages.directory.locator('#main-content').getByRole('button', { name: 'Load more' }).click(); await expect.poll(() => oldPage.started).toBe(true);
    const oldList = hold(), newList = hold(); state.list = oldList; state.rereadList = newList;
    await pages.list.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect.poll(() => oldList.started).toBe(true);
    await healthy.focus(); await pages.worker.bringToFront(); await search.evaluate((input: HTMLInputElement) => { input.focus(); input.setSelectionRange(1, 4); });
    expect(await healthy.evaluate(element => element === document.activeElement)).toBe(true);
    state.revoked = true;
    await pages.detail.locator('.project-title-actions button').evaluate((button: HTMLButtonElement) => button.click());
    await expect.poll(() => state.denials).toBeGreaterThan(0);
    await expect(pages.directory.getByRole('heading', { name: 'Private Project', exact: true })).toHaveCount(0);
    await expect(pages.directory.getByRole('heading', { name: 'Healthy Project', exact: true })).toBeVisible();
    await expect(dialog.getByText('Private Project', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Healthy Project', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: new RegExp(privateId) })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /Healthy Project/ })).toBeChecked();
    await expect(search).toBeFocused(); await expect(draft).toHaveValue('[invalid draft');
    expect(await search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 4]);
    expect(await healthy.evaluate(element => element === document.activeElement)).toBe(true);
    await expect(card).toContainText('Task information awaiting synchronization');
    await expect.poll(() => newList.started).toBe(true);
    oldPage.release(); oldMetadata.release(); oldWorker.release(); oldList.release();
    await expect.poll(() => [oldPage.finished, oldMetadata.finished, oldWorker.finished, oldList.finished].every(Boolean)).toBe(true);
    await expect(pages.directory.getByRole('heading', { name: 'Private Project', exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Private Project', { exact: true })).toHaveCount(0);
    await expect(card).toContainText('Task information awaiting synchronization');
    await expect(search).toBeFocused(); await expect(draft).toHaveValue('[invalid draft');
    expect(await search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 4]);
    for (const [name, page] of [['directory-withdrawn', pages.directory], ['worker-list-withdrawn', pages.list], ['configuration-withdrawn', pages.worker]] as const) {
      const path = testInfo.outputPath(`${name}.png`); await page.screenshot({ path }); await testInfo.attach(name, { path, contentType: 'image/png' });
    }
    newList.release(); await expect(card).toContainText('1 task in progress');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(pages.worker.getByRole('heading', { name: privateId, exact: true })).toBeVisible();
    await pages.worker.getByRole('button', { name: `Remove project ${privateId}` }).click();
    await expect(pages.worker.getByRole('heading', { name: privateId, exact: true })).toHaveCount(0);
    await expect(pages.worker.getByRole('heading', { name: 'Healthy Project', exact: true })).toBeVisible();
    await expect(draft).toHaveValue('[invalid draft');
    await pages.worker.locator('#worker-tab-overview').click();
    await expect(pages.worker.getByText('Private worker task', { exact: true })).toHaveCount(0);
    await expect(pages.worker.getByText('Healthy worker task', { exact: true })).toBeVisible();
    await expect(pages.worker.getByRole('heading', { name: 'Worker 1', exact: true })).toBeVisible();
    await expect(pages.worker.getByText(/CPU model/).first()).toBeVisible();
    state.revoked = false;
    await pages.detail.goto(`/projects/${privateId}`); await pages.detail.getByRole('tab', { name: 'Task list' }).click(); await pages.detail.getByRole('tab', { name: 'Standalone tasks' }).click(); await expect(pages.detail.getByText('Private task', { exact: true }).first()).toBeVisible();
    await pages.directory.locator('.project-list-heading button').last().click();
    await expect(pages.directory.getByRole('heading', { name: 'Private Project', exact: true })).toBeVisible();
    await pages.worker.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(pages.worker.getByText('Private worker task', { exact: true })).toBeVisible();
    await pages.worker.locator('#worker-tab-configuration').click();
    await pages.worker.getByRole('button', { name: /Choose projects/ }).first().click();
    await pages.worker.getByRole('dialog').getByRole('checkbox', { name: /Private Project/ }).check();
    await pages.worker.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    await expect(pages.worker.getByRole('heading', { name: 'Private Project', exact: true })).toBeVisible();
    await expect(draft).toHaveValue('[invalid draft');
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const bundleRoot = fileURLToPath(new URL('../../../../.tmp/project-withdrawal/app', import.meta.url));
    const files = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
    const bundle = createHash('sha256');
    for (const path of (await files(bundleRoot)).sort()) { bundle.update(relative(bundleRoot, path)); bundle.update('\0'); bundle.update(await readFile(path)); }
    const evidence = { boundary: 'Production app in Chromium with controlled HTTP responses; real shared IndexedDB and BroadcastChannel, not a live service.',
      visibility: 'Headless tabs keep document.visibilityState visible to sustain polling.',
      gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
      testSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
      bundleSha256: bundle.digest('hex'), browser: context.browser()?.version(),
      lateResponses: ['directory pagination', 'configuration metadata', 'Worker detail', 'Worker list'],
      withdrawn: true, healthyFocusAndSelection: true, retainedDraft: true, freshAccessRestored: true };
    const evidencePath = testInfo.outputPath('evidence.json'); await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach('controlled-api-evidence', { path: evidencePath, contentType: 'application/json' });
  } finally { for (const value of pending) value.release(); }
});
