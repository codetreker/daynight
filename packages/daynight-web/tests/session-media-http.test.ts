import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestSessionApi } from '../src/api/sessions';
import { cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import type { SessionArchiveManifest } from '../../daynight/src/session/archive';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fence = { sessionId: id(1), testExecutionId: id(2), executionGeneration: '1' };
const userId = id(3);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const response = (value: unknown) => Response.json(value, { headers: { 'Daynight-User-ID': userId } });
afterEach(() => vi.unstubAllGlobals());

function savedBundle() {
  const original = Buffer.from('saved bytes');
  const resource = { resourceId: id(4), status: 'available' as const, name: 'saved.txt', mediaType: 'text/plain', byteLength: String(original.length), sha256: hash(original), error: null };
  const entries = [{ entryId: id(5), entrySeq: '1', revision: '1', kind: 'assistant_message', content: [{ type: 'resource', resourceId: resource.resourceId, label: 'saved file' }] }];
  const timeline = JSON.stringify({ entries });
  const manifest: SessionArchiveManifest = { schemaVersion: 3, contentKind: 'native_timeline', recordId: fence.sessionId, fence, provider: 'codex', nativeSessionId: null, controllerId: id(6), controllerInstanceId: id(7), timeline: { fileId: id(8), byteLength: String(Buffer.byteLength(timeline)), sha256: hash(timeline) }, resources: [{ resource, blobId: id(9) }], completeness: 'complete' };
  return { original, resource, entries, timeline, manifest, status: { state: 'ready', sha256: hash(JSON.stringify(manifest)), byteLength: String(Buffer.byteLength(JSON.stringify(manifest))), errorCode: null, schemaVersion: 3, completeness: 'complete' } };
}

it('loads saved metadata without preloading originals and verifies an original on demand', async () => {
  const saved = savedBundle();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/archive/content')) return response(saved.manifest);
    if (url.endsWith('/archive')) return response({ archive: saved.status });
    if (url.includes('/archive/files/')) return new Response(saved.timeline, { headers: { 'Daynight-User-ID': userId } });
    expect(new Headers(init?.headers).get('Daynight-Session-Content-Revision')).toBe('2');
    const parsed = new URL(url);
    expect(parsed.pathname).toContain(`/resources/${saved.resource.resourceId}/content`);
    return response({ resourceId: saved.resource.resourceId, byteLength: saved.resource.byteLength, sha256: saved.resource.sha256, offset: '0', data: saved.original.toString('base64'), eof: true });
  });
  vi.stubGlobal('fetch', fetch);
  const api = createTestSessionApi(fence.sessionId, userId, vi.fn());
  const archive = await api.archiveContent(fence.sessionId, new AbortController().signal);
  expect(archive.schemaVersion).toBe(3);
  expect(archive.entries).toEqual(saved.entries);
  expect(archive.resources).toEqual(saved.manifest.resources);
  expect(fetch).toHaveBeenCalledTimes(3);
  const client = api.resources(fence, () => true);
  try { expect(await client.readResource(saved.resource, new AbortController().signal)).toEqual(new Uint8Array(saved.original)); }
  finally { await client.close(); }
  expect(fetch).toHaveBeenCalledTimes(4);
});

it.each(['manifest', 'timeline'])('rejects a corrupt saved %s rather than converting it into a partial archive', async subject => {
  const saved = savedBundle();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/archive/content')) return response(saved.manifest);
    if (url.endsWith('/archive')) return response({ archive: { ...saved.status, ...(subject === 'manifest' ? { sha256: 'a'.repeat(64) } : {}) } });
    if (url.includes('/archive/files/')) return new Response(subject === 'timeline' ? '{}' : saved.timeline, { headers: { 'Daynight-User-ID': userId } });
    throw new Error('Archive metadata must not preload originals.');
  }));
  await expect(createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal)).rejects.toThrow();
});

it('rejects a corrupt original on demand while preserving the saved archive completeness', async () => {
  const saved = savedBundle();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/archive/content')) return response(saved.manifest);
    if (url.endsWith('/archive')) return response({ archive: saved.status });
    if (url.includes('/archive/files/')) return new Response(saved.timeline, { headers: { 'Daynight-User-ID': userId } });
    return response({ resourceId: saved.resource.resourceId, byteLength: saved.resource.byteLength, sha256: saved.resource.sha256, offset: '0', data: Buffer.from('wrong bytes').toString('base64'), eof: true });
  }));
  const api = createTestSessionApi(fence.sessionId, userId, vi.fn());
  const archive = await api.archiveContent(fence.sessionId, new AbortController().signal);
  const client = api.resources(fence, () => true);
  try { await expect(client.readResource(saved.resource, new AbortController().signal)).rejects.toThrow(); }
  finally { await client.close(); }
  expect(archive.schemaVersion === 3 && archive.completeness).toBe('complete');
});

it('binds the shared media client to the Web authorization generation', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const client = createTestSessionApi(fence.sessionId, userId, vi.fn()).resources(fence, () => true);
  invalidateAuthRequests();
  await expect(client.capabilities(new AbortController().signal)).rejects.toThrow('authorization');
  expect(fetch).not.toHaveBeenCalled();
  await client.close();
});

it('rejects invalid UTF-8 before hashing a saved manifest', async () => {
  const saved = savedBundle();
  // Blob.text replaces the invalid byte with U+FFFD. That replacement must not
  // become a different, apparently valid document with a matching status hash.
  const encoded = Buffer.from(JSON.stringify(saved.manifest).replace('saved.txt', '\ufffd'));
  const replacement = encoded.indexOf(Buffer.from('\ufffd'));
  const invalid = Buffer.concat([encoded.subarray(0, replacement), Buffer.from([0xff]), encoded.subarray(replacement + 3)]);
  const repaired = Buffer.from(invalid.toString('utf8'));
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/archive/content')) return new Response(invalid, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    if (url.endsWith('/archive')) return response({ archive: { ...saved.status, sha256: hash(repaired), byteLength: String(repaired.length) } });
    if (url.includes('/archive/files/')) return new Response(saved.timeline, { headers: { 'Daynight-User-ID': userId } });
    return response({ resourceId: saved.resource.resourceId, byteLength: saved.resource.byteLength, sha256: saved.resource.sha256, offset: '0', data: saved.original.toString('base64'), eof: true });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects an archive whose authorization generation changes while reading its timeline', async () => {
  const saved = savedBundle();
  saved.timeline = JSON.stringify({ entries: [] });
  saved.manifest = { ...saved.manifest, resources: [], timeline: { ...saved.manifest.timeline, byteLength: String(Buffer.byteLength(saved.timeline)), sha256: hash(saved.timeline) } };
  saved.status.sha256 = hash(JSON.stringify(saved.manifest));
  saved.status.byteLength = String(Buffer.byteLength(JSON.stringify(saved.manifest)));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/archive/content')) return response(saved.manifest);
    if (url.endsWith('/archive')) return response({ archive: saved.status });
    invalidateAuthRequests();
    return new Response(saved.timeline, { headers: { 'Daynight-User-ID': userId } });
  }));
  await expect(createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal)).rejects.toThrow();
});


it('cancels a Session media response while its body is being read', async () => {
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const cancelled = vi.fn();
  let dispatched!: AbortSignal;
  const stream = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel: cancelled }, { highWaterMark: 0 });
  let cancelReader!: ReturnType<typeof vi.spyOn>;
  const getReader = stream.getReader.bind(stream);
  vi.spyOn(stream, 'getReader').mockImplementation(() => { const reader = getReader(); cancelReader = vi.spyOn(reader, 'cancel'); return reader; });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    dispatched = init.signal as AbortSignal;
    return new Response(stream, { headers: { 'Daynight-User-ID': userId } });
  }));
  const client = createTestSessionApi(fence.sessionId, userId, vi.fn()).resources(fence, () => true);
  try {
    const pending = client.capabilities(new AbortController().signal);
    await reading;
    cancelAuthNetworkRequests();
    await expect(pending).rejects.toBe(dispatched.reason);
    expect(cancelled).toHaveBeenCalledWith(dispatched.reason);
  expect(cancelReader).toHaveBeenCalledOnce();
  } finally { await client.close(); }
});


it('rejects a Session resource cancelled during digest verification', async () => {
  const saved = savedBundle();
  let digestStarted!: () => void, finishDigest!: (value: ArrayBuffer) => void;
  const digesting = new Promise<void>(resolve => { digestStarted = resolve; });
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => {
    digestStarted();
    return new Promise<ArrayBuffer>(resolve => { finishDigest = resolve; });
  });
  let dispatched!: AbortSignal;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    dispatched = init.signal as AbortSignal;
    return response({ resourceId: saved.resource.resourceId, byteLength: saved.resource.byteLength, sha256: saved.resource.sha256, offset: '0', data: saved.original.toString('base64'), eof: true });
  });
  vi.stubGlobal('fetch', fetch);
  const client = createTestSessionApi(fence.sessionId, userId, vi.fn()).resources(fence, () => true);
  try {
    const pending = client.readResource(saved.resource, new AbortController().signal);
    await digesting;
    cancelAuthNetworkRequests();
    finishDigest(Uint8Array.from(Buffer.from(saved.resource.sha256, 'hex')).buffer);
    await expect(pending).rejects.toBe(dispatched.reason);
    expect(fetch).toHaveBeenCalledOnce();
  } finally { digest.mockRestore(); await client.close(); }
});


it('does not dispatch another resource chunk when its prior lifetime is cancelled in the gate', async () => {
  const original = Buffer.alloc(524_289, 7);
  const resource = { resourceId: id(4), status: 'available' as const, name: 'large.bin', mediaType: 'application/octet-stream', byteLength: String(original.length), sha256: hash(original), error: null };
  let waiting!: () => void, paused = false, resume!: () => void;
  const gate = new Promise<void>(resolve => { waiting = resolve; });
  const addEventListener = AbortSignal.prototype.addEventListener;
  const spy = vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function (this: AbortSignal, ...args: Parameters<AbortSignal['addEventListener']>) {
    if (paused && args[0] === 'abort') { paused = false; waiting(); }
    return addEventListener.apply(this, args);
  });
  let dispatched!: AbortSignal;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    dispatched = init.signal as AbortSignal;
    return response({ resourceId: resource.resourceId, byteLength: resource.byteLength, sha256: resource.sha256, offset: '0', data: original.subarray(0, 524_288).toString('base64'), eof: false });
  });
  vi.stubGlobal('fetch', fetch);
  const client = createTestSessionApi(fence.sessionId, userId, vi.fn()).resources(fence, () => true);
  try {
    const pending = client.readResource(resource, new AbortController().signal, () => { resume = pauseAuthRequests(); paused = true; });
    await gate;
    cancelAuthNetworkRequests();
    await expect(pending).rejects.toBe(dispatched.reason);
    expect(fetch).toHaveBeenCalledOnce();
  } finally { resume?.(); spy.mockRestore(); await client.close(); }
});


it('preserves network cancellation if archive verification rejects after cancellation', async () => {
  const saved = savedBundle();
  let started!: () => void, fail!: (cause: Error) => void;
  const digesting = new Promise<void>(resolve => { started = resolve; });
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => {
    started();
    return new Promise<ArrayBuffer>((_resolve, reject) => { fail = reject; });
  });
  let dispatched!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { dispatched = init.signal as AbortSignal; return response(saved.manifest); }));
  try {
    const pending = createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal, { ...saved.status, state: 'ready', schemaVersion: 3, completeness: 'complete' });
    await digesting;
    cancelAuthNetworkRequests();
    fail(new Error('digest failed'));
    await expect(pending).rejects.toBe(dispatched.reason);
  } finally { digest.mockRestore(); }
});


it('settles the resource read and close when reader cancellation never finishes', async () => {
  let started!: () => void, failCleanup!: (cause: Error) => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  let dispatched!: AbortSignal, cancelReader!: ReturnType<typeof vi.spyOn>;
  const stream = new ReadableStream<Uint8Array>({ pull() { started(); } }, { highWaterMark: 0 });
  const getReader = stream.getReader.bind(stream);
  vi.spyOn(stream, 'getReader').mockImplementation(() => {
    const reader = getReader(), actualCancel = reader.cancel.bind(reader);
    cancelReader = vi.spyOn(reader, 'cancel').mockImplementation(reason => {
      void actualCancel(reason).catch(() => undefined);
      return new Promise<void>((_resolve, reject) => { failCleanup = reject; });
    });
    return reader;
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    dispatched = init.signal as AbortSignal;
    return new Response(stream, { headers: { 'Daynight-User-ID': userId } });
  }));
  const client = createTestSessionApi(fence.sessionId, userId, vi.fn()).resources(fence, () => true);
  const pending = client.capabilities(new AbortController().signal);
  await reading;
  cancelAuthNetworkRequests();
  await expect(pending).rejects.toBe(dispatched.reason);
  await client.close();
  expect(cancelReader).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
  failCleanup(new Error('late cleanup failure'));
  await Promise.resolve();
});

it('uses the schema3 timeline limit for its response length and still parses the saved metadata', async () => {
  const saved = savedBundle();
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/archive/content')) return response(saved.manifest);
    if (url.endsWith('/archive')) return response({ archive: saved.status });
    if (url.includes('/archive/files/')) return new Response(saved.timeline, { headers: { 'Daynight-User-ID': userId, 'Content-Length': String(64 * 1024 * 1024 + 1025) } });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetch);
  const archive = await createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal);
  expect(archive.entries).toEqual(saved.entries);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('rejects an oversized schema3 timeline length before consuming its body', async () => {
  const saved = savedBundle();
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/archive/content')) return response(saved.manifest);
    if (url.endsWith('/archive')) return response({ archive: saved.status });
    if (url.includes('/archive/files/')) return new Response(stream, { headers: { 'Daynight-User-ID': userId, 'Content-Length': String(128 * 1024 * 1024 + 1) } });
    throw new Error('Unexpected request');
  }));
  await expect(createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal)).rejects.toThrow();
  expect(cancelled).toHaveBeenCalledOnce();
});

it('keeps the legacy archive response length bound', async () => {
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'Daynight-User-ID': userId, 'Content-Length': String(64 * 1024 * 1024 + 1025), 'Content-Type': 'application/json' } })));
  await expect(createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal)).rejects.toThrow();
  expect(cancelled).toHaveBeenCalledOnce();
});
