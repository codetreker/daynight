import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA } from '../../src/features/task-cache/database';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { openSessionImages } from '../helpers/sessionImageBrowser';

const alice = TEST_VIEWER_ID, bob = '00000000-0000-4000-8000-000000000202';
const projectId = '00000000-0000-4000-8000-000000000031', taskId = '00000000-0000-4000-8000-000000000041';
const personalId = '00000000-0000-4000-8000-000000000701', time = '2026-10-20T09:00:00Z';
const base = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const tags = [{ id: '00000000-0000-4000-8000-000000000091', name: 'Frontend' }];
const task = detailFixture(projectId, taskId, { title: 'Private task', assignedTo: alice, version: 5n, tags });
const graph = graphFixture([task]);

async function cache(page: Page) {
  return page.evaluate(async ({ databaseName, schema, aliceId, bobId, project }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      if (db.version !== schema) throw new Error('Unexpected cache schema');
      const tx = db.transaction(['projects', 'summaries', 'details', 'profiles'], 'readonly');
      const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      const read = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const [projects, summaries, details, profiles, otherProject, otherSummaries, otherDetails, otherProfiles, summaryRecord, detailRecord] = await Promise.all([
        read(tx.objectStore('projects').index('by-user').getAll(aliceId)), read(tx.objectStore('summaries').index('by-user').count(aliceId)),
        read(tx.objectStore('details').index('by-user').count(aliceId)), read(tx.objectStore('profiles').index('by-user').count(aliceId)),
        read(tx.objectStore('projects').get([bobId, project])), read(tx.objectStore('summaries').index('by-project').count([bobId, project])),
        read(tx.objectStore('details').index('by-project').count([bobId, project])), read(tx.objectStore('profiles').index('by-project').count([bobId, project])),
        read(tx.objectStore('summaries').getAll()), read(tx.objectStore('details').getAll()),
      ]);
      await done;
      return { active: projects.filter((item: { state: string }) => item.state === 'active').length, summaries, details, profiles,
        otherActive: otherProject?.state === 'active', otherSummaries, otherDetails, otherProfiles, summaryTags: summaryRecord[0]?.summary.tags, detailTags: detailRecord[0]?.detail.tags };
    } finally { db.close(); }
  }, { databaseName: TASK_CACHE_DATABASE, schema: TASK_CACHE_SCHEMA, aliceId: alice, bobId: bob, project: projectId });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) test(`account change retains a real task and draft at ${viewport.width}px until reload`, async ({ page, context }) => {
  await page.setViewportSize(viewport);
  let actor = alice;
  let meReads = 0;
  const requests: string[] = [];
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, observed = actor;
    requests.push(`${request.method()} ${path} ${observed}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': observed, ...extra } });
    if (path === '/api/v1/me') { meReads++; return send({ id: observed, personalTeam: { id: personalId, kind: 'personal', name: null }, name: observed === alice ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null }); }
    if (path === '/api/v1/projects') return send({ items: observed === alice ? [graph.project] : [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return observed === alice ? send(graph.project) : send({ error: { code: 'not_found', message: 'not found', requestId: 'denied' } }, 404);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: observed, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return observed === alice ? send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties, tagsForTask: () => task.tags })) : send({ error: { code: 'not_found', message: 'not found', requestId: 'denied' } }, 404);
    if (path === `/api/v1/projects/${projectId}/access`) return observed === alice ? send(directAccessFixture(projectId)) : send({ error: { code: 'not_found', message: 'not found', requestId: 'denied' } }, 404);
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: alice, version: TEST_PROFILE_VERSION, name: 'Alice', avatarUrl: null, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === base) return send(task, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${base}/attachments`) return send({ items: [{ path: 'index.html', contentType: 'text/html', sizeBytes: 40, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path === `${base}/preview/index.html`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : '<button id="inner">Private reader</button>', headers: { 'Content-Type': 'text/html', 'Daynight-User-ID': observed } });
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  await page.goto(`/projects/${projectId}?view=keep#fragment`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  await page.locator(`#standalone-task-${taskId}`).click();
  const dialog = page.locator('.task-detail-dialog');
  await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await dialog.getByRole('button', { name: /^index\.html/ }).click();
  const frame = dialog.locator('iframe'); await expect(frame.contentFrame().locator('#inner')).toBeVisible();
  await dialog.locator('.attachment-upload-disclosure > summary').click();
  const input = dialog.getByRole('textbox', { name: 'Target relative path' });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('private') });
  await input.fill('draft/private.txt'); await input.focus();
  await expect.poll(async () => { const values = await cache(page); return values.summaries > 0 && values.details > 0 && values.profiles > 0; }).toBe(true);
  const persistedTags = await cache(page);
  expect(persistedTags.summaryTags).toEqual(tags); expect(persistedTags.detailTags).toEqual(tags);
  const detail = await dialog.elementHandle(), originalFrame = await frame.elementHandle();
  const other = await context.newPage();
  try {
    const beforeFocus = meReads;
    await other.goto('about:blank'); await other.bringToFront(); await page.bringToFront();
    expect(meReads).toBe(beforeFocus);
    actor = bob;
    await other.goto(`/auth/complete?returnPath=${encodeURIComponent('/?from=login#public')}&callbackPath=%2Fauth%2Fcallback`);
    await expect(other).toHaveURL('http://127.0.0.1:4206/?from=login#public');
    await expect(dialog.getByText('Account changed', { exact: true })).toBeVisible();
    await expect(input).toBeFocused(); await expect(input).toHaveValue('draft/private.txt');
    expect(await detail!.evaluate(element => element.isConnected)).toBe(true);
    expect(await originalFrame!.evaluate(element => element.isConnected)).toBe(true);
    const persisted = await cache(page);
    expect(persisted.active).toBeGreaterThan(0); expect(persisted.details).toBeGreaterThan(0);
    expect(persisted.otherActive).toBe(false);
    const reads = meReads, count = requests.length;
    await input.fill('draft/continued.txt');
    await dialog.getByRole('button', { name: /upload/i }).first().evaluate((button: HTMLButtonElement) => button.click());
    expect(requests.slice(count)).toEqual([]); expect(meReads).toBe(reads);
    await expect(dialog.getByRole('button', { name: 'Refresh page' })).toBeVisible();
    const url = page.url();
    await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Refresh page' }).click()]);
    expect(page.url()).toBe(url);
    await expect(page.getByRole('button', { name: /Account menu: Bob/ })).toBeVisible();
    expect(meReads).toBeGreaterThan(reads);
  } finally { await other.close(); await detail!.dispose(); await originalFrame!.dispose(); }
});

test('login completion publishes to another same-origin page before replacing a public target', async ({ page: receiver, context }) => {
  const receiverGate = Promise.withResolvers<void>();
  const reloadGate = Promise.withResolvers<void>();
  const senderGate = Promise.withResolvers<void>();
  let receiverReads = 0, senderReads = 0;
  const user = (id: string) => ({ id, personalTeam: { id: personalId, kind: 'personal', name: null }, name: id === alice ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null });
  await receiver.addInitScript(() => {
    localStorage.setItem('daynight.web.locale', 'en');
    const observations: { storage: (string | null)[]; messages: unknown[] } = { storage: [], messages: [] };
    (window as typeof window & { identityObservations: typeof observations }).identityObservations = observations;
    window.addEventListener('storage', event => { if (event.key === 'daynight.activeUser') observations.storage.push(event.newValue); });
    const channel = new BroadcastChannel('daynight-identity');
    channel.addEventListener('message', event => observations.messages.push(event.data));
  });
  await receiver.route('**/api/v1/me', async route => {
    receiverReads++;
    await (receiverReads === 1 ? receiverGate.promise : reloadGate.promise);
    await route.fulfill({ json: user(alice), headers: { 'Daynight-User-ID': alice } });
  });
  const sender = await context.newPage();
  await sender.route('**/api/v1/me', async route => {
    senderReads++;
    await senderGate.promise;
    await route.fulfill({ json: user(bob), headers: { 'Daynight-User-ID': bob } });
  });
  const receiverURL = `/auth/complete?returnPath=${encodeURIComponent('/login')}&callbackPath=%2Fauth%2Fcallback`;
  const target = '/?from=login%26return#public';
  const senderURL = `/auth/complete?returnPath=${encodeURIComponent(target)}&callbackPath=%2Fauth%2Fcallback`;
  try {
    await receiver.goto(receiverURL);
    await expect.poll(() => receiverReads).toBe(1);
    const brand = receiver.getByRole('link', { name: 'Daynight' });
    await brand.focus();
    await expect(brand).toBeFocused();
    await sender.goto(senderURL);
    await expect.poll(() => senderReads).toBe(1);
    await expect(sender).toHaveURL(new RegExp('/auth/complete\\?'));
    senderGate.resolve();
    await expect(sender).toHaveURL(`http://127.0.0.1:4206${target}`);
    await expect.poll(() => receiver.evaluate(() => (window as typeof window & { identityObservations: { storage: (string | null)[] } }).identityObservations.storage)).toContain(JSON.stringify(bob));
    await expect.poll(() => receiver.evaluate(() => (window as typeof window & { identityObservations: { messages: unknown[] } }).identityObservations.messages)).toContain('identity-changed');
    receiverGate.resolve();
    await receiver.bringToFront();
    await expect(receiver.getByText('Account changed', { exact: true })).toBeVisible();
    const refresh = receiver.getByRole('button', { name: 'Refresh page' });
    await expect(refresh).toBeVisible();
    await expect(brand).toBeFocused();
    await expect(receiver).toHaveURL(`http://127.0.0.1:4206${receiverURL}`);
    expect(await receiver.evaluate(() => localStorage.getItem('daynight.activeUser'))).toBe(JSON.stringify(bob));
    expect(receiverReads).toBe(1);
    expect(senderReads).toBe(1);
    await receiver.keyboard.press('Tab');
    await expect(refresh).toBeFocused();
    await Promise.all([receiver.waitForEvent('load'), receiver.keyboard.press('Enter')]);
    await expect.poll(() => receiverReads).toBe(2);
    await expect(receiver).toHaveURL(`http://127.0.0.1:4206${receiverURL}`);
  } finally {
    receiverGate.resolve();
    reloadGate.resolve();
    senderGate.resolve();
    await sender.close();
  }
});

async function installDirectFixture(context: BrowserContext, page: Page) {
  let actor: string | null = alice;
  const heldRead = Promise.withResolvers<void>();
  const startedRead = Promise.withResolvers<void>();
  const requests: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('daynight.web.locale', 'en');
    const observed = { dispatched: false, aborted: false };
    (window as typeof window & { controlledRead: typeof observed }).controlledRead = observed;
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/attachments/files/guide.txt')) {
        observed.dispatched = true;
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (signal?.aborted) observed.aborted = true;
        else signal?.addEventListener('abort', () => { observed.aborted = true; }, { once: true });
      }
      return original(input, init);
    };
  });
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, observed = actor;
    requests.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', ...(observed === null ? {} : { 'Daynight-User-ID': observed }), ...extra } });
    if (path === '/api/v1/auth/logout') { actor = null; return route.fulfill({ status: 204 }); }
    if (path === '/api/v1/me') return observed === null ? send({ error: { code: 'unauthorized', message: 'signed out', requestId: 'fixture' } }, 401) : send({ id: observed, personalTeam: { id: personalId, kind: 'personal', name: null }, name: observed === alice ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: observed, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties, tagsForTask: () => task.tags }));
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: alice, version: TEST_PROFILE_VERSION, name: 'Alice', avatarUrl: null, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === base) return send(task, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${base}/attachments`) return send({ items: [{ path: 'guide.txt', contentType: 'text/plain', sizeBytes: 12, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path === `${base}/attachments/files/guide.txt`) {
      startedRead.resolve(); await heldRead.promise;
      return route.fulfill({ body: 'Private text', headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': alice } }).catch(() => {});
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return { requests, startedRead, heldRead };
}

for (const modal of ['task', 'attachment'] as const) test(`real logout retains standalone detail and ${modal} confirmation, aborting dispatched read`, async ({ page, context }) => {
  const f = await installDirectFixture(context, page);
  const sender = await context.newPage();
  try {
    await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=attachments#private`);
    const detail = page.locator('.task-detail-page');
    await expect(detail.locator('.task-detail-title')).toHaveText('Private task');
    await detail.getByRole('button', { name: /^guide\.txt/ }).click();
    await f.startedRead.promise;
    await expect.poll(() => page.evaluate(() => (window as typeof window & { controlledRead: { dispatched: boolean } }).controlledRead.dispatched)).toBe(true);
    if (modal === 'task') {
      await detail.getByRole('button', { name: 'More task actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete task', exact: true }).click();
    } else {
      await detail.getByLabel('More actions: guide.txt').click();
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    }
    const dialog = modal === 'task' ? page.getByRole('alertdialog') : page.locator('.attachment-delete-dialog');
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeFocused();
    const originalDetail = await detail.elementHandle(), originalDialog = await dialog.elementHandle();
    await sender.goto('/projects');
    await sender.getByRole('button', { name: /Account menu: Alice/ }).click();
    await sender.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('daynight.activeUser'))).toBe('null');
    await expect(dialog.getByText('Account changed', { exact: true })).toBeVisible();
    await expect(cancel).toBeFocused();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { controlledRead: { aborted: boolean } }).controlledRead.aborted)).toBe(true);
    expect(await originalDetail!.evaluate(node => node.isConnected)).toBe(true);
    expect(await originalDialog!.evaluate(node => node.isConnected)).toBe(true);
    const refresh = dialog.getByRole('button', { name: 'Refresh page', exact: true });
    await expect(refresh).toBeVisible();
    for (let i = 0; i < 10 && !await refresh.evaluate(node => node === document.activeElement); i++) await page.keyboard.press('Tab');
    await expect(refresh).toBeFocused();
    const before = f.requests.filter(value => !value.includes('/api/v1/me')).length;
    const confirm = dialog.locator('footer button').last();
    await expect(confirm).toBeDisabled();
    await confirm.evaluate((button: HTMLButtonElement) => button.click());
    expect(f.requests.filter(value => !value.includes('/api/v1/me')).length).toBe(before);
    await originalDetail!.dispose(); await originalDialog!.dispose();
  } finally { f.heldRead.resolve(); await sender.close(); }
});

for (const surface of ['fullscreen', 'image'] as const) test(`real login preserves ${surface} Session presentation and stops live transport`, async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let meReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/me') meReads++; });
  const f = await openSessionImages(page);
  expect(() => f.publishEntry(f.entries[0]!)).not.toThrow();
  const host = page.locator('.task-agent-session:visible');
  const draft = host.getByRole('textbox', { name: 'Message' });
  await draft.fill('Session draft');
  const fullscreen = host.locator('.session-fullscreen-toggle');
  await fullscreen.click();
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  let image: Awaited<ReturnType<Page['locator']>> | null = null;
  let focused = draft;
  if (surface === 'image') {
    const trigger = host.getByRole('button', { name: 'View image: Example.png', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const dialog = page.locator('dialog.session-image-preview');
    image = dialog.locator('img');
    await expect(image).toHaveJSProperty('naturalWidth', 3);
    focused = dialog.getByRole('button', { name: 'Close image preview' });
  } else await draft.focus();
  await expect(focused).toBeFocused();
  const node = await (image ?? host).elementHandle();
  const sender = await context.newPage();
  await sender.route('**/api/v1/me', route => route.fulfill({ json: { id: bob, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Bob', email: null, emailVerified: null, avatarUrl: null }, headers: { 'Daynight-User-ID': bob } }));
  try {
    const reads = meReads;
    const remoteReads = { current: f.observations.currentReads, timeline: f.observations.timelineReads, resources: f.observations.resources.length };
    await sender.goto(`/auth/complete?returnPath=${encodeURIComponent('/?from=login#public')}&callbackPath=%2Fauth%2Fcallback`);
    await expect(sender).toHaveURL('http://127.0.0.1:4206/?from=login#public');
    const active = surface === 'image' ? page.locator('dialog.session-image-preview') : host.locator('.session-header');
    await expect(active.getByText('Account changed', { exact: true })).toBeVisible();
    await expect(focused).toBeFocused();
    await expect.poll(() => {
      try { f.publishEntry(f.entries[0]!); return false; }
      catch (error) { if (error instanceof Error && error.message === 'An existing entry and active channel are required.') return true; throw error; }
    }).toBe(true);
    expect(await node!.evaluate(element => element.isConnected)).toBe(true);
    await expect(draft).toHaveValue('Session draft');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    expect(meReads).toBe(reads);
    const refresh = active.getByRole('button', { name: 'Refresh page', exact: true });
    for (let i = 0; i < 15 && !await refresh.evaluate(element => element === document.activeElement); i++) await page.keyboard.press('Tab');
    await expect(refresh).toBeFocused();
    if (image) {
      await expect(image).toHaveJSProperty('naturalWidth', 3);
      await expect(active.getByRole('button', { name: 'Download image: Example.png' })).toBeDisabled();
    }
    expect({ current: f.observations.currentReads, timeline: f.observations.timelineReads, resources: f.observations.resources.length }).toEqual(remoteReads);
    expect(f.observations.writes).toEqual([]);
    expect(f.observations.pageErrors).toEqual([]);
  } finally { f.releaseBefore(); await sender.close(); await node!.dispose(); }
});
