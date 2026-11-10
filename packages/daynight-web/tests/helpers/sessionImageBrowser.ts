import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { SessionResource, TimelineEntry } from '../../src/api/types';
import { sessionFence, type SessionSnapshot } from '../../../daynight/src/session/protocol';
import { detailFixture, graphFixture } from './taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from './taskSync';
import type { TaskSessionSnapshot } from './session';
import { pngImage } from './pngImage';
import { sessionImageSamples } from './sessionImages';
import { stringifyWireJson } from './wireJson';

const uuid = (index: number) => `00000088-1111-4111-8111-${String(index).padStart(12, '0')}`;
type ImageFixtureOptions = { readonly dimensions?: readonly [number, number]; readonly longLabel?: boolean };
export function imageBrowserData(options: ImageFixtureOptions = {}) {
  const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
  const bodies = new Map<string, Buffer>();
  const resources: SessionResource[] = Object.entries(sessionImageSamples).map(([format, base64], index) => {
    const bytes = index === 0 && options.dimensions ? pngImage(...options.dimensions) : Buffer.from(base64, 'base64'), resourceId = uuid(index + 1); bodies.set(resourceId, bytes);
    return { resourceId, revision: '1', name: index === 0 && options.longLabel ? `${'long-image-name-'.repeat(30)}.png` : `Example.${format}`, status: 'available', mediaType: `image/${format}`, byteLength: String(bytes.length), sha256: createHash('sha256').update(bytes).digest('hex'), width: index === 0 && options.dimensions ? options.dimensions[0] : 3, height: index === 0 && options.dimensions ? options.dimensions[1] : 2, frameCount: 1, error: null };
  });
  const entries: TimelineEntry[] = resources.map((resource, index) => ({ entryId: uuid(100 + index), entrySeq: String(index + 1), revision: '1', imageProjectionError: null, kind: index === 0 ? 'user_message' : 'assistant_message', content: [{ type: 'text', text: `Original ${resource.name}` }, { type: 'image', imageId: uuid(200 + index), resourceId: resource.resourceId, label: resource.name }] }));
  const token = '![Linked image](file:///controlled/picture.png)', text = `[Report ${token} details](https://example.com/report)`;
  const imageId = uuid(250);
  entries.push({ entryId: uuid(150), entrySeq: '6', revision: '1', imageProjectionError: null, kind: 'assistant_message', content: [{ type: 'markdown', partId: uuid(251), revision: '1', text, textSha256: createHash('sha256').update(text).digest('hex'), complete: true, truncated: false, bindings: [{ start: text.indexOf(token), end: text.indexOf(token) + token.length, imageId, part: { type: 'image', imageId, resourceId: resources[0]!.resourceId, label: 'Linked image' } }], retainedImages: [] }] });
  return { source, resources, entries, bodies };
}

/** Production App, routes and client; only HTTP/WebSocket responses are controlled. */
export async function openSessionImages(page: Page, { entry = 'task', ...options }: ImageFixtureOptions & { entry?: 'task' | 'test' | 'task-dialog'; prepend?: boolean; tool?: boolean } = {}) {
  const data = imageBrowserData(options), { source, resources, bodies } = data;
  const textEntry = (index: number): TimelineEntry => ({ entryId: uuid(1000 + index), entrySeq: String(index), revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: `### Saved message ${index}\n\n${'Saved text history preserves its reading position while earlier messages arrive. '.repeat(5)}` }] });
  const entries = options.prepend ? Array.from({ length: 30 }, (_, index) => textEntry(index + 21)) : data.entries;
  const older = options.prepend ? Array.from({ length: 20 }, (_, index) => textEntry(index + 1)) : [];
  if (options.tool) {
    const resource = { ...resources[0]!, resourceId: uuid(500), name: 'Tool output.png' }; resources.push(resource); bodies.set(resource.resourceId, bodies.get(resources[0]!.resourceId)!);
    entries.push({ entryId: uuid(501), entrySeq: '7', revision: '1', imageProjectionError: null, kind: 'tool_call', callId: uuid(502), name: 'inspect_image', input: 'Read the saved screenshot', output: [{ type: 'image', imageId: uuid(503), resourceId: resource.resourceId, label: resource.name }], status: 'completed', truncated: false });
  }
  let releaseBefore!: () => void;
  const beforeReleased = new Promise<void>(resolve => { releaseBefore = resolve; });
  const projectId = source.identity.projectId, taskId = source.identity.taskId, taskRoot = `/api/v1/projects/${projectId}/tasks/${taskId}`;
  const taskEntry = entry !== 'test', personalId = uuid(900), time = '2026-11-06T00:00:00Z';
  const taskSnapshot: TaskSessionSnapshot = { ...source, lastEventSeq: '0', lastTimelineSeq: entries.at(-1)!.entrySeq, lifecycle: 'active', activity: 'idle', connectionState: 'connected', currentTurnId: null, operations: { canSend: true, canCancel: false, canRespond: false } };
  const { claimId: _claim, identity: _identity, ...base } = taskSnapshot;
  const snapshot: SessionSnapshot = taskEntry ? taskSnapshot : { ...base, testExecutionId: uuid(901), identity: { ownerUserId: TEST_VIEWER_ID, controllerId: source.identity.controllerId, controllerInstanceId: source.identity.controllerInstanceId, provider: source.identity.provider, agentControlMode: 'web', nativeSessionId: 'image-browser-native' } };
  const root = taskEntry ? `${taskRoot}/sessions/${source.sessionId}` : `/api/v1/test-sessions/${source.sessionId}`;
  const worker = { claimId: source.claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: source.identity.workerId, machine: { id: source.identity.controllerId, name: 'Image fixture' }, platform: 'macos', agent: source.identity.provider, agentControlMode: 'web', worktreeId: source.identity.worktreeId, phase: 'executing', herdr: null, nativeSessionId: 'image-browser-native', claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Session image acceptance', status: 'in_progress', ready: false, properties: { worker } }), graph = graphFixture([detail]);
  const observations = { currentReads: 0, timelineReads: 0, beforeReads: 0, resources: [] as string[], writes: [] as string[], pageErrors: [] as string[] };
  const channels = new Set<WebSocketRoute>();
  let eventSeq = 0n;
  const currentSnapshot = () => ({ ...snapshot, lastEventSeq: String(eventSeq) });
  const publishEntry = (updated: TimelineEntry) => {
    const index = entries.findIndex(item => item.entryId === updated.entryId);
    if (index < 0 || channels.size === 0) throw new Error('An existing entry and active channel are required.');
    entries[index] = updated; eventSeq++;
    const event = { protocol: snapshot.protocol, ...sessionFence(snapshot), connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq: String(eventSeq), kind: 'timeline_upsert', payload: updated };
    for (const socket of channels) socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'event', cursor: `image-event-${eventSeq}`, event }));
  };
  page.on('pageerror', error => observations.pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.routeWebSocket('**/channel*', socket => {
    channels.add(socket); socket.onClose(() => { channels.delete(socket); });
    socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot: currentSnapshot(), cursor: `image-event-${eventSeq}` }));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) observations.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === taskRoot) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${taskRoot}/sessions`) return send({ items: [], nextCursor: null });
    if (path === (taskEntry ? `${taskRoot}/sessions/current` : root)) { observations.currentReads++; return send(taskEntry ? { status: 'registered', session: currentSnapshot() } : { session: currentSnapshot() }); }
    if (path === `${root}/timeline`) {
      const before = options.prepend && url.searchParams.get('direction') === 'before';
      if (before) { observations.beforeReads++; await beforeReleased; } else observations.timelineReads++;
      const items = before ? older : !options.prepend && observations.timelineReads > 1 ? entries.map((item, index) => index === entries.length - 1 && item.kind === 'assistant_message' ? { ...item, revision: String(observations.timelineReads), content: [...item.content, { type: 'text', text: `History refresh ${observations.timelineReads}` }] } : item) : entries;
      return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items, resources, beforeCursor: options.prepend && !before ? 'before-21' : null, afterCursor: null, hasMoreBefore: !!options.prepend && !before, hasMoreAfter: false, lastEventSeq: String(eventSeq) });
    }
    const resourceId = path.startsWith(`${root}/resources/`) && path.endsWith('/content') ? path.split('/').at(-2) : null;
    if (resourceId && bodies.has(resourceId)) {
      observations.resources.push(resourceId); const resource = resources.find(item => item.resourceId === resourceId)!, bytes = bodies.get(resourceId)!;
      if (url.searchParams.has('offset')) { const offset = Number(url.searchParams.get('offset')), chunk = bytes.subarray(offset, offset + Number(url.searchParams.get('limit'))); return send({ resourceId, sha256: resource.sha256, byteLength: resource.byteLength, offset: String(offset), data: chunk.toString('base64'), eof: offset + chunk.length === bytes.length }); }
      return route.fulfill({ status: 200, body: bytes, headers: { 'Content-Type': resource.mediaType!, 'Content-Length': resource.byteLength!, 'Daynight-User-ID': TEST_VIEWER_ID } });
    }
    if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    if (path.endsWith('/steps')) return send({ projectId, taskId, version: detail.version, steps: [] });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: source.sessionId } }, 404);
  });
  if (entry === 'task-dialog') {
    await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click(); await page.locator(`#standalone-task-${taskId}`).click(); await page.getByRole('tab', { name: 'Session', exact: true }).click();
  } else await page.goto(taskEntry ? `/projects/${projectId}/tasks/${taskId}?tab=session` : `/test-sessions/${source.sessionId}`);
  if (options.tool) {
    await page.getByRole('button', { name: 'Display', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Standard', exact: true }).click(); await page.keyboard.press('Escape');
  }
  await expect(page.locator('.session-entry')).toHaveCount(entries.length);
  return { snapshot, root, taskRoot, resources, bodies, entries, older, observations, releaseBefore, publishEntry };
}
