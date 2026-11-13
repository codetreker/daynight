import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { parseSessionArchiveManifest, verifySessionArchiveMetadata } from '../../../daynight/src/session/archive';
import type { SessionHistoryItem } from '../../src/api/terminal-sessions';
import { imageBrowserData } from '../helpers/sessionImageBrowser';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const uuid = (index: number) => `00000089-1111-4111-8111-${String(index).padStart(12, '0')}`;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Execute the production App and fixed-record reader against controlled HTTP. */
async function openRecords(page: Page, completed: boolean) {
  const { source, resources, entries, bodies } = imageBrowserData();
  const projectId = source.identity.projectId, taskId = source.identity.taskId, root = `/api/v1/projects/${projectId}/tasks/${taskId}`;
  const time = '2026-11-06T00:00:00Z', personalId = uuid(1);
  const worker = { claimId: source.claimId, state: 'completed', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Image record fixture' }, platform: 'macos', agent: 'codex', agentControlMode: 'web',
    worktreeId: source.identity.worktreeId, phase: 'completing', herdr: null, nativeSessionId: source.identity.nativeSessionId, claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Saved image records', status: completed ? 'done' : 'todo', ready: !completed, completedAt: completed ? time : null, properties: completed ? { worker } : {} });
  const graph = graphFixture([detail]);
  const records = [
    { sessionId: source.sessionId, claimId: source.claimId, name: 'Completed saved record', time },
    { sessionId: uuid(2), claimId: uuid(3), name: 'Attachment saved record', time: '2026-11-07T00:00:00Z' },
  ].map((record, index) => {
    const savedEntries = [...entries, { entryId: uuid(100 + index), entrySeq: '7', revision: '1', kind: 'assistant_message' as const, content: [{ type: 'text' as const, text: record.name }] }];
    const timeline = JSON.stringify({ entries: savedEntries });
    const manifest = { schemaVersion: 3, contentKind: 'native_timeline', recordId: record.sessionId,
      fence: { sessionId: record.sessionId, claimId: record.claimId, executionGeneration: source.executionGeneration },
      controllerId: source.identity.controllerId, controllerInstanceId: source.identity.controllerInstanceId, provider: source.identity.provider, nativeSessionId: source.identity.nativeSessionId,
      timeline: { fileId: uuid(200 + index), byteLength: String(Buffer.byteLength(timeline)), sha256: hash(timeline) },
      resources: resources.map((resource, at) => ({ resource, blobId: uuid(300 + index * 10 + at) })), completeness: 'complete' };
    const bytes = JSON.stringify(manifest), status = { state: 'ready' as const, schemaVersion: 3 as const, sha256: hash(bytes), byteLength: String(Buffer.byteLength(bytes)), errorCode: null, completeness: 'complete' as const };
    const item: SessionHistoryItem = { ...manifest.fence, agentControlMode: 'web', contentKind: 'native_timeline', createdAt: record.time, endedAt: record.time, archive: { state: 'ready', sha256: status.sha256, byteLength: status.byteLength, completeness: 'complete' } };
    return { ...record, item, manifest, status, timeline };
  });
  await Promise.all(records.map(record => verifySessionArchiveMetadata(parseSessionArchiveManifest(record.manifest), new TextEncoder().encode(record.timeline))));
  const observations = { currentReads: 0, channels: 0, writes: [] as string[], resourceReads: [] as string[], completedResourceReads: [] as string[], cancelledResourceReads: [] as string[], failedResourceReads: [] as { key: string; error: string | null }[], pageErrors: [] as string[], unexpected: [] as string[] };
  const resourceRequests = new Map<Request, string>();
  page.on('requestfinished', request => {
    const key = resourceRequests.get(request);
    if (key === undefined) return;
    observations.completedResourceReads.push(key); resourceRequests.delete(request);
  });
  page.on('requestfailed', request => {
    const key = resourceRequests.get(request);
    if (key === undefined) return;
    const error = request.failure()?.errorText ?? null;
    if (error === 'net::ERR_ABORTED') observations.cancelledResourceReads.push(key);
    else observations.failedResourceReads.push({ key, error });
    resourceRequests.delete(request);
  });
  page.on('pageerror', error => observations.pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.routeWebSocket('**/channel*', socket => { observations.channels++; socket.close(); });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) observations.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-graph`) return send(graph);
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === root) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${root}/sessions`) return send({ items: records.toReversed().map(record => record.item), nextCursor: null });
    if (path === `${root}/sessions/current`) {
      observations.currentReads++;
      return send({ status: 'registered', session: { ...source, lifecycle: 'archived', connectionState: 'disconnected', lastEventSeq: '0', lastTimelineSeq: '7', activity: 'idle', currentTurnId: null, operations: { canSend: false, canCancel: false, canRespond: false } } });
    }
    for (const record of records) {
      const base = `${root}/sessions/${record.sessionId}`;
      if (path === `${base}/archive`) return send({ archive: record.status });
      if (path === `${base}/archive/content`) return send(record.manifest);
      if (path === `${base}/archive/files/${record.manifest.timeline.fileId}`) return route.fulfill({ status: 200, body: record.timeline, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
      const resourceId = path.startsWith(`${base}/resources/`) && path.endsWith('/content') ? path.split('/').at(-2) : null;
      if (resourceId && bodies.has(resourceId)) {
        const key = `${record.sessionId}/${resourceId}`;
        observations.resourceReads.push(key); resourceRequests.set(request, key);
        const resource = resources.find(item => item.resourceId === resourceId)!, original = bodies.get(resourceId)!, offset = Number(url.searchParams.get('offset'));
        const bytes = original.subarray(offset, offset + Number(url.searchParams.get('limit')));
        return send({ resourceId, byteLength: resource.byteLength, sha256: resource.sha256, offset: String(offset), data: bytes.toString('base64'), eof: offset + bytes.length === original.length });
      }
    }
    if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    if (path.endsWith('/steps')) return send({ projectId, taskId, version: detail.version, steps: [] });
    observations.unexpected.push(`${request.method()} ${path}`);
    return send({ error: { code: 'not_found', message: 'Unexpected record fixture request', requestId: source.sessionId } }, 404);
  });
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=session`);
  const selected = records[completed ? 0 : 1]!;
  await expect(page.getByText(selected.name, { exact: true })).toBeVisible();
  return { records, resources, bodies, observations };
}

async function assertDecoded(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => ({ width: (node as HTMLImageElement).naturalWidth, height: (node as HTMLImageElement).naturalHeight, loaded: (node as HTMLImageElement).complete }))).toEqual({ width: 3, height: 2, loaded: true });
}
async function inspectOriginals(page: Page, fixture: Awaited<ReturnType<typeof openRecords>>, fullscreen: boolean) {
  const host = page.locator('.task-agent-session:visible');
  await expect(host.locator('textarea')).toHaveCount(0);
  await expect(host.getByRole('button', { name: /^(Send|Interrupt|Take control|Retry source)$/ })).toHaveCount(0);
  if (fullscreen) await host.getByRole('button', { name: 'Enter Session fullscreen', exact: true }).click();
  await host.locator('.session-timeline').hover(); await page.mouse.wheel(0, -5000);
  for (const resource of fixture.resources) {
    const trigger = host.getByRole('button', { name: `View image: ${resource.name}`, exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await assertDecoded(trigger.getByRole('img', { name: resource.name, exact: true }));
    const readCount = () => fixture.observations.resourceReads.filter(key => key.endsWith(`/${resource.resourceId}`)).length;
    const readsBeforePreview = readCount();
    await trigger.click();
    const preview = host.getByRole('dialog', { name: resource.name, exact: true });
    await assertDecoded(preview.getByRole('img', { name: resource.name, exact: true }));
    expect(await preview.getByRole('img').evaluate(async node => {
      const bytes = await (await fetch((node as HTMLImageElement).src)).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    })).toBe(resource.sha256);
    await preview.getByRole('button', { name: 'Original size', exact: true }).click();
    await expect(preview.getByRole('button', { name: 'Original size', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const downloaded = page.waitForEvent('download');
    await preview.getByRole('button', { name: `Download image: ${resource.name}`, exact: true }).click();
    const download = await downloaded, path = await download.path();
    expect(path).not.toBeNull();
    const bytes = readFileSync(path!);
    expect(hash(bytes)).toBe(resource.sha256); expect(bytes).toEqual(fixture.bodies.get(resource.resourceId));
    await page.keyboard.press('Escape');
    await expect(preview).not.toBeVisible(); await expect(trigger).toBeFocused();
    expect(readCount()).toBe(readsBeforePreview);
    if (fullscreen) await expect(host).toHaveClass(/session-fullscreen/);
  }
  if (fullscreen) { await page.keyboard.press('Escape'); await expect(host).not.toHaveClass(/session-fullscreen/); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [390, 1360]) test(`${width}px completed and attachment records decode and download five original formats without live operations`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await openRecords(page, true);
  // Completed-claim discovery reads current once; fixed records never create a live client.
  expect(fixture.observations.currentReads).toBe(1);
  await inspectOriginals(page, fixture, true);
  await page.screenshot({ path: info.outputPath('completed-record.png') });
  await page.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await page.locator('.managed-session-records').getByRole('button', { name: /2026-11-07/ }).click();
  await expect(page.getByText(fixture.records[1]!.name, { exact: true })).toBeVisible();
  await inspectOriginals(page, fixture, false);
  await page.screenshot({ path: info.outputPath('attachment-record.png') });
  // Initial layout can move an in-flight thumbnail outside its read margin.
  // Cancellation is not a completed download; each original still completes once.
  await expect.poll(() => fixture.observations.completedResourceReads.length + fixture.observations.cancelledResourceReads.length + fixture.observations.failedResourceReads.length).toBe(fixture.observations.resourceReads.length);
  for (const record of fixture.records) for (const resource of fixture.resources) expect(fixture.observations.completedResourceReads.filter(key => key === `${record.sessionId}/${resource.resourceId}`)).toHaveLength(1);
  expect(fixture.observations.failedResourceReads).toEqual([]);
  expect(fixture.observations.currentReads).toBe(1); expect(fixture.observations.channels).toBe(0);
  expect(fixture.observations.writes).toEqual([]); expect(fixture.observations.pageErrors).toEqual([]); expect(fixture.observations.unexpected).toEqual([]);
  await info.attach('record-image-evidence', { body: JSON.stringify({ boundary: 'Production App and fixed-record reader with controlled HTTP; real Chrome pixel decoding, Blob preview and original downloads.', width, formats: fixture.resources.map(resource => ({ mediaType: resource.mediaType, sha256: resource.sha256, byteLength: resource.byteLength })), observations: fixture.observations }), contentType: 'application/json' });
});

test('unclaimed saved history reads only fixed records with no current lookup', async ({ page }) => {
  const fixture = await openRecords(page, false);
  const resource = fixture.resources[0]!;
  await page.locator('.session-timeline').hover(); await page.mouse.wheel(0, -5000);
  const trigger = page.getByRole('button', { name: `View image: ${resource.name}`, exact: true });
  await trigger.scrollIntoViewIfNeeded(); await assertDecoded(trigger.getByRole('img'));
  expect(fixture.observations.currentReads).toBe(0); expect(fixture.observations.channels).toBe(0); expect(fixture.observations.writes).toEqual([]);
});
