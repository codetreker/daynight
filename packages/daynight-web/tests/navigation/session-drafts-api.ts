import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { ImageCapabilities, ImageUploadReceipt, ImageUploadSpec, SessionCommand, SessionOperation, SessionSnapshot } from '../../../daynight/src/session/protocol';
import { sessionFence, sessionFenceKey } from '../../../daynight/src/session/protocol';
import { verifyImageContainer } from '../../src/features/task-agent-session/images/image-format';
import { pngImage } from '../helpers/pngImage';
import type {} from './session-drafts-fixture';
import type {} from './session-drafts-client-fixture';
const snapshotJson: SessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));

const userId = '00000071-1111-4111-8111-111111111111';
export const boundary = 'Production Composer, ImageDraftController, SessionDraftStore, resource client and local image store; controlled HTTP and operation outcomes; native browser IndexedDB, Blob, Web Locks, BroadcastChannel, decoding and DOM. No real service, Worker or Provider.';
export const fixtureUrl = '/tests/navigation/session-drafts-fixture.html';
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const file = (name = 'image.png', bytes = pngImage(3, 2)) => ({ name, mimeType: 'image/png', buffer: bytes });
export async function seedLegacyDraft(page: Page, text: string, revision: string, submission: { operationId: string; revision: string } | null = null) {
  const fence = sessionFence(snapshotJson), draftKey = `daynight:session-draft:${userId}:task:${snapshotJson.identity.projectId}:${snapshotJson.identity.taskId}:${sessionFenceKey(fence)}`;
  const operationKey = `daynight:session-operations:${userId}:${fence.sessionId}:${'claimId' in fence ? fence.claimId : `test:${fence.testExecutionId}`}:${fence.executionGeneration}`;
  const operation: SessionOperation | null = submission ? { protocol: snapshotJson.protocol, ...fence, operationId: submission.operationId, kind: 'send_message', state: 'unknown', providerResult: null, error: null } : null;
  await page.addInitScript(({ draftKey, operationKey, value, operation, marker }) => {
    if (sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(draftKey, JSON.stringify(value));
    if (operation) sessionStorage.setItem(operationKey, JSON.stringify([{ operation }]));
    sessionStorage.setItem(marker, 'seeded');
  }, { draftKey, operationKey, value: { text, revision, submission }, operation, marker: `fixture-legacy-seed:${randomUUID()}` });
  return { draftKey, operationKey, operation };
}
export function exactPng(byteLength: number): Buffer {
  const original = pngImage(3, 2), length = byteLength - original.length - 12;
  if (length < 0) throw new Error('The requested PNG size is too small.');
  const payload = Buffer.concat([Buffer.from('paDd'), Buffer.alloc(length)]), prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
  let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  prefix.writeUInt32BE(length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([original.subarray(0, -12), prefix, payload, suffix, original.subarray(-12)]);
}
export async function installDraftAPI(context: BrowserContext, overrides: Partial<ImageCapabilities> = {}) {
  const capability: ImageCapabilities = { revision: '2', providerRevision: '1', expectedNativeSessionId: 'native-thread-1', modelId: 'vision', controlsRevision: '3', send: 'supported', steer: 'unsupported', reasonCode: null, inputMediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImageBytes: '10485760', maxMessageImageBytes: '20971520', maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 256 }, ...overrides };
  await context.addInitScript(capabilities => { window.sessionDraftOptions = { capabilities }; }, overrides);
  const uploads = new Map<string, { spec: ImageUploadSpec; receipt: ImageUploadReceipt; chunks: Buffer[] }>();
  const originalOperations = new Map<string, SessionOperation>();
  const observations = { prepares: [] as string[], chunks: [] as { uploadId: string; offset: string; length: number }[], completes: [] as string[], releases: [] as string[], commands: [] as SessionCommand[], queries: [] as string[], errors: [] as string[] };
  let dispatchMode: 'confirmed' | 'held' | 'lost' | 'capability_changed' = 'confirmed', queryState: SessionOperation['state'] | '404' = 'unknown';
  const held: Route[] = [];
  const budget = { revision: '1', maxBytes: '1073741824', committedBytes: '0', reservedBytes: '0', maxResources: 1000, committedResources: 0, reservedResources: 0 };
  const snapshot = { ...snapshotJson, contentRevision: 2, imageBudget: budget, capabilities: { ...snapshotJson.capabilities, images: capability }, lastEventSeq: '0', lastTimelineSeq: '0' };
  const publishSnapshots = new Set<() => void>();
  await context.routeWebSocket('**/api/v1/**/channel*', socket => {
    const publish = () => socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId, snapshot, cursor: 'zero' }));
    publishSnapshots.add(publish); socket.onClose(() => { publishSnapshots.delete(publish); }); publish();
  });
  const operation = (command: SessionCommand, state: SessionOperation['state']): SessionOperation => ({ protocol: command.protocol, sessionId: command.sessionId, ...('claimId' in command ? { claimId: command.claimId! } : { testExecutionId: command.testExecutionId! }), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state, providerResult: null, error: null });
  const handle = async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const principal = new URL(request.frame().url()).searchParams.get('actor') ?? userId;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': principal } });
    if (path.endsWith('/sessions/current')) return send({ status: 'registered', session: snapshot });
    if (path.endsWith('/timeline')) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (path.endsWith('/image-capabilities')) return send({ contentRevision: 2, capabilities: capability, budget });
    if (path === '/draft-fixture-api/dispatch' || path.endsWith('/commands')) {
      const command = request.postDataJSON() as SessionCommand; observations.commands.push(command);
      if (dispatchMode === 'held') { held.push(route); return; }
      if (dispatchMode === 'lost') return route.abort('failed');
      if (dispatchMode === 'capability_changed') return send({ error: { code: 'capability_changed', message: 'Image capability changed before dispatch.', requestId: randomUUID() } }, 409);
      return path.endsWith('/commands') ? send({ operation: operation(command, 'confirmed'), operationUrl: `${url.origin}${path.replace(/commands$/, `operations/${command.operationId}`)}` }, 202) : send(operation(command, 'confirmed'));
    }
    if (path.startsWith('/draft-fixture-api/operation/') || path.includes('/operations/')) {
      const id = path.split('/').at(-1)!; observations.queries.push(id);
      if (queryState === '404') return send({ error: { code: 'not_found', message: 'Unknown operation.', requestId: randomUUID() } }, 404);
      const command = observations.commands.find(value => value.operationId === id);
      const original = originalOperations.get(id);
      if (!command && !original) return send({ error: 'unknown operation' }, 404);
      const result = command ? operation(command, queryState) : { ...original!, state: queryState };
      return send(path.includes('/operations/') ? { operation: result, currentBinding: true } : result);
    }
    const match = /\/image-uploads\/([^/]+)(?:\/(chunks|complete))?$/.exec(path);
    if (!match) { observations.errors.push(`${request.method()} ${path}`); return send({ error: 'unexpected request' }, 404); }
    const id = match[1]!, action = match[2];
    if (request.method() === 'PUT' && !action) {
      const spec = request.postDataJSON() as ImageUploadSpec; observations.prepares.push(id);
      const receipt: ImageUploadReceipt = { uploadId: id, imageId: spec.imageId, target: spec.target, state: 'receiving', acceptedOffset: '0', spec: { name: spec.name, mediaType: spec.mediaType, byteLength: spec.byteLength, sha256: spec.sha256 }, resource: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), error: null };
      uploads.set(id, { spec, receipt, chunks: [] }); return send(receipt, 201);
    }
    const upload = uploads.get(id);
    if (!upload) return send({ error: 'unknown upload' }, 404);
    if (action === 'chunks') {
      const bytes = request.postDataBuffer()!, offset = url.searchParams.get('offset')!;
      expect(offset).toBe(upload.receipt.acceptedOffset); expect(request.headers()['daynight-chunk-sha256']).toBe(sha256(bytes));
      observations.chunks.push({ uploadId: id, offset, length: bytes.length }); upload.chunks.push(bytes);
      upload.receipt = { ...upload.receipt, acceptedOffset: String(Number(offset) + bytes.length) }; return send(upload.receipt);
    }
    if (action === 'complete') {
      const bytes = Buffer.concat(upload.chunks), container = verifyImageContainer(new Uint8Array(bytes), upload.spec.mediaType);
      expect(bytes.length).toBe(Number(upload.spec.byteLength)); expect(sha256(bytes)).toBe(upload.spec.sha256); expect(container.canvas).not.toBeNull();
      observations.completes.push(id); upload.receipt = { ...upload.receipt, state: 'complete', resource: { resourceId: randomUUID(), revision: '1', name: upload.spec.name, status: 'available', mediaType: upload.spec.mediaType, byteLength: upload.spec.byteLength, sha256: upload.spec.sha256, width: container.canvas!.width, height: container.canvas!.height, frameCount: container.frameCount!, error: null } }; return send(upload.receipt);
    }
    if (request.method() === 'DELETE') { observations.releases.push(id); upload.receipt = { ...upload.receipt, state: 'released', resource: null }; }
    return send(upload.receipt);
  };
  await context.route('**/draft-fixture-api/**', handle);
  await context.route('**/api/v1/projects/**/sessions/**', handle);
  return { observations, uploads, capability,
    changeTarget: (nativeSessionId: string, executionGeneration = snapshot.executionGeneration) => {
      snapshot.identity = { ...snapshot.identity, nativeSessionId }; snapshot.executionGeneration = executionGeneration;
      snapshot.sessionRevision = String(BigInt(snapshot.sessionRevision) + 1n);
      Object.assign(capability, { expectedNativeSessionId: nativeSessionId, revision: String(BigInt(capability.revision) + 1n) });
      publishSnapshots.forEach(publish => publish());
    },
    setDispatch: (mode: typeof dispatchMode) => { dispatchMode = mode; }, setQuery: (state: typeof queryState) => { queryState = state; }, seedOperation: (value: SessionOperation) => { originalOperations.set(value.operationId, value); }, cleanup: async () => { await Promise.all(held.splice(0).map(route => route.abort().catch(() => {}))); } };
}
export async function openDraft(page: Page) {
  await page.goto(fixtureUrl);
  await expect(page.getByRole('textbox')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.sessionDraftHarness && !window.sessionDraftHarness.controller.getSnapshot().loading)).toBe(true);
}
export const saved = (page: Page) => page.evaluate(() => window.sessionDraftHarness.read());
export const current = (page: Page) => page.evaluate(() => { const { items, frozenItems, ...rest } = window.sessionDraftHarness.controller.getSnapshot(); return { ...rest, items: items.map(({ asset, ...item }) => ({ ...item, asset: asset?.key ?? null })), frozenItems: frozenItems.map(({ asset, ...item }) => ({ ...item, asset: asset?.key ?? null })) }; });
export const ready = async (page: Page, count: number) => {
  let observed: unknown;
  try {
    await expect.poll(async () => {
      const view = await current(page);
      const state = { count: view.items.length, saving: view.saving, canSend: view.canSend, error: view.error };
      observed = { ...state, disabledReason: view.disabledReason,
        uploads: view.items.map(item => ({ label: item.label, uploadId: item.uploadId, status: item.status, progress: item.progress })) };
      return state;
    }).toEqual({ count, saving: false, canSend: true, error: null });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLast observed draft state: ${JSON.stringify(observed)}`, { cause: error });
  }
};
