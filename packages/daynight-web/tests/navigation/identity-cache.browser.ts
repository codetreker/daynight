import { expect, test, type Page } from '@playwright/test';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA } from '../../src/features/task-cache/database';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const alice = TEST_VIEWER_ID, bob = '00000000-0000-4000-8000-000000000202';
const projectId = '00000000-0000-4000-8000-000000000031', taskId = '00000000-0000-4000-8000-000000000041';
const personalId = '00000000-0000-4000-8000-000000000701', time = '2026-10-20T09:00:00Z';
const base = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const task = detailFixture(projectId, taskId, { title: 'Private task', assignedTo: alice, version: 5n });
const graph = graphFixture([task]);

async function cache(page: Page) {
  return page.evaluate(async ({ databaseName, schema, aliceId, bobId, project }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      if (db.version !== schema) throw new Error('Unexpected cache schema');
      const tx = db.transaction(['projects', 'summaries', 'details', 'profiles'], 'readonly');
      const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      const read = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const [projects, summaries, details, profiles, otherProject, otherSummaries, otherDetails, otherProfiles] = await Promise.all([
        read(tx.objectStore('projects').index('by-user').getAll(aliceId)), read(tx.objectStore('summaries').index('by-user').count(aliceId)),
        read(tx.objectStore('details').index('by-user').count(aliceId)), read(tx.objectStore('profiles').index('by-user').count(aliceId)),
        read(tx.objectStore('projects').get([bobId, project])), read(tx.objectStore('summaries').index('by-project').count([bobId, project])),
        read(tx.objectStore('details').index('by-project').count([bobId, project])), read(tx.objectStore('profiles').index('by-project').count([bobId, project])),
      ]);
      await done;
      return { active: projects.filter((item: { state: string }) => item.state === 'active').length, summaries, details, profiles,
        otherActive: otherProject?.state === 'active', otherSummaries, otherDetails, otherProfiles };
    } finally { db.close(); }
  }, { databaseName: TASK_CACHE_DATABASE, schema: TASK_CACHE_SCHEMA, aliceId: alice, bobId: bob, project: projectId });
}

for (const outcome of ['new-account', 'revoked'] as const) test(`real tab return gates requests and purges IndexedDB after ${outcome}`, async ({ page, context }) => {
  let actor = alice;
  let revoked = false;
  let hold: Promise<void> | null = null;
  const events: string[] = [];
  let meReads = 0;
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, observed = actor;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': observed, ...extra } });
    if (path === '/api/v1/me') { meReads++; events.push(`identity-start:${observed}`); if (hold) await hold; events.push(`identity-response:${observed}`); return send({ id: observed, personalTeam: { id: personalId, kind: 'personal', name: null }, name: observed === alice ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null }); }
    if (path === '/api/v1/projects') return send({ items: observed === alice ? [graph.project] : [], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: observed, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/task-sync`) {
      events.push(`graph:${observed}`);
      if (observed === bob || revoked) return send({ error: { code: 'not_found', message: 'not found', requestId: 'denied' } }, 404);
      return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    }
    if (path === `/api/v1/projects/${projectId}/access`) return observed === alice ? send(directAccessFixture(projectId)) : send({ error: { code: 'not_found', message: 'not found', requestId: 'denied' } }, 404);
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: alice, version: TEST_PROFILE_VERSION, name: 'Alice', avatarUrl: null, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === base) return send(task, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${base}/attachments`) return send({ items: [{ path: 'index.html', contentType: 'text/html', sizeBytes: 40, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path === `${base}/preview/index.html`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : '<button id="inner">Private reader</button>', headers: { 'Content-Type': 'text/html', 'Daynight-User-ID': observed } });
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  await page.locator(`#standalone-task-${taskId}`).click();
  const dialog = page.locator('.task-detail-dialog'); await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await dialog.getByRole('button', { name: /^index\.html/ }).click();
  const frame = dialog.locator('iframe'); await expect(frame.contentFrame().locator('#inner')).toBeVisible();
  await dialog.locator('.attachment-upload-disclosure > summary').click();
  const input = dialog.getByRole('textbox', { name: 'Target relative path' });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('private') });
  await input.fill('draft/private.txt'); await input.focus();
  await expect.poll(async () => { const values = await cache(page); return values.summaries > 0 && values.details > 0 && values.profiles > 0; }).toBe(true);
  const shell = await page.locator('.auth-shell').elementHandle(), detail = await dialog.elementHandle(), originalFrame = await frame.elementHandle();
  const other = await context.newPage();
  const a = await context.newCDPSession(page), b = await context.newCDPSession(other);
  await a.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await b.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await a.detach(); await b.detach(); await other.goto('about:blank');
  let gate = Promise.withResolvers<void>();
  try {
    await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    const baseline = events.filter(event => event.startsWith('graph:')).length;
    await page.locator('.project-title-actions>button').evaluate((button: HTMLButtonElement) => button.click());
    hold = gate.promise; const before = meReads;
    await page.bringToFront(); await expect.poll(() => meReads).toBeGreaterThan(before);
    expect(events.filter(event => event.startsWith('graph:'))).toHaveLength(baseline);
    await expect(dialog).toBeVisible(); await expect(input).toBeFocused(); await expect(input).toHaveValue('draft/private.txt');
    expect(await shell!.evaluate(element => element.isConnected && !element.hasAttribute('inert'))).toBe(true);
    expect(await detail!.evaluate(element => element.isConnected)).toBe(true);
    expect(await originalFrame!.evaluate(element => element.isConnected)).toBe(true);
    hold = null; gate.resolve();
    await expect.poll(() => events.filter(event => event.startsWith('graph:')).length).toBeGreaterThan(baseline);
    expect(events.lastIndexOf(`identity-response:${alice}`)).toBeLessThan(events.lastIndexOf(`graph:${alice}`));
    await expect(input).toHaveValue('draft/private.txt');
    await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    const graphCount = events.filter(event => event.startsWith('graph:')).length;
    await page.locator('.project-title-actions>button').evaluate((button: HTMLButtonElement) => button.click());
    if (outcome === 'new-account') actor = bob; else revoked = true;
    gate = Promise.withResolvers<void>(); hold = gate.promise; const reads = meReads;
    await page.bringToFront(); await expect.poll(() => meReads).toBeGreaterThan(reads);
    expect(events.filter(event => event.startsWith('graph:'))).toHaveLength(graphCount);
    await expect(dialog).toBeVisible(); await expect(input).toHaveValue('draft/private.txt');
    hold = null; gate.resolve();
    const target = outcome === 'new-account' ? bob : alice;
    await expect(page.getByRole('button', { name: outcome === 'new-account' ? /Account menu: Bob/ : /Account menu: Alice/ })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => events.filter(event => event.startsWith('graph:')).length).toBeGreaterThan(graphCount);
    expect(events.lastIndexOf(`identity-response:${target}`)).toBeLessThan(events.lastIndexOf(`graph:${target}`));
    expect(await shell!.evaluate(element => element.isConnected)).toBe(outcome === 'revoked');
    expect(await detail!.evaluate(element => element.isConnected)).toBe(false);
    expect(await originalFrame!.evaluate(element => element.isConnected)).toBe(false);
    await expect.poll(() => cache(page)).toEqual({ active: 0, summaries: 0, details: 0, profiles: 0, otherActive: false, otherSummaries: 0, otherDetails: 0, otherProfiles: 0 });
  } finally { gate.resolve(); await other.close(); await shell!.dispose(); await detail!.dispose(); await originalFrame!.dispose(); }
});
