import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestSessionApi } from '../src/api/sessions';
import { SESSION_ARCHIVE_MAX_BYTES, SESSION_ARCHIVE_TIMELINE_MAX_BYTES, type SessionArchiveManifest } from '../../daynight/src/session/archive';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fence = { sessionId: id(1), testExecutionId: id(2), executionGeneration: '1' };
const userId = id(3);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const response = (value: unknown) => Response.json(value, { headers: { 'Daynight-User-ID': userId } });
afterEach(() => vi.unstubAllGlobals());

it.each([true, false])('loads and verifies a real 65 MiB schema3 timeline (Content-Length=%s)', async (withLength) => {
  const text = 'x'.repeat(1024 * 1024);
  const entries = Array.from({ length: 65 }, (_, i) => ({ entryId: id(i + 10), entrySeq: String(i + 1), revision: '1', kind: 'assistant_message', content: [{ type: 'text', text }] }));
  const timeline = Buffer.from(JSON.stringify({ entries }));
  expect(timeline.byteLength).toBeGreaterThan(SESSION_ARCHIVE_MAX_BYTES + 1024);
  const manifest: SessionArchiveManifest = { schemaVersion: 3, contentKind: 'native_timeline', recordId: fence.sessionId, fence, provider: 'codex', nativeSessionId: null, controllerId: id(6), controllerInstanceId: id(7), timeline: { fileId: id(8), byteLength: String(timeline.byteLength), sha256: hash(timeline) }, resources: [], completeness: 'complete' };
  const manifestBytes = JSON.stringify(manifest);
  const status = { state: 'ready' as const, sha256: hash(manifestBytes), byteLength: String(Buffer.byteLength(manifestBytes)), errorCode: null, schemaVersion: 3 as const, completeness: 'complete' as const };
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/archive/content')) return response(manifest);
    if (url.endsWith('/archive')) return response({ archive: status });
    if (url.includes('/archive/files/')) return new Response(timeline, { headers: { 'Daynight-User-ID': userId, ...(withLength ? { 'Content-Length': String(timeline.byteLength) } : {}) } });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetch);
  const archive = await createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal);
  expect(archive.schemaVersion).toBe(3);
  expect(archive.entries).toHaveLength(65);
  expect(archive.entries[64]).toEqual(entries[64]);
  expect(fetch).toHaveBeenCalledTimes(3);
}, 180_000);

it.each(['legacy', 'schema3'])('stops an oversized %s stream without Content-Length', async kind => {
  const limit = kind === 'legacy' ? SESSION_ARCHIVE_MAX_BYTES + 1024 : SESSION_ARCHIVE_TIMELINE_MAX_BYTES;
  const chunk = new Uint8Array(1024 * 1024);
  let delivered = 0;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { delivered += chunk.length; controller.enqueue(chunk); }, cancel: cancelled }, { highWaterMark: 0 });
  const emptyTimeline = Buffer.from('{"entries":[]}');
  const manifest: SessionArchiveManifest = { schemaVersion: 3, contentKind: 'native_timeline', recordId: fence.sessionId, fence, provider: 'codex', nativeSessionId: null, controllerId: id(6), controllerInstanceId: id(7), timeline: { fileId: id(8), byteLength: String(emptyTimeline.byteLength), sha256: hash(emptyTimeline) }, resources: [], completeness: 'complete' };
  const rawManifest = JSON.stringify(manifest);
  const status = { state: 'ready' as const, sha256: hash(rawManifest), byteLength: String(Buffer.byteLength(rawManifest)), errorCode: null, schemaVersion: 3 as const, completeness: 'complete' as const };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (kind === 'schema3' && url.endsWith('/archive/content')) return response(manifest);
    if (kind === 'schema3' && url.endsWith('/archive')) return response({ archive: status });
    return new Response(stream, { headers: { 'Daynight-User-ID': userId, 'Content-Type': 'application/json' } });
  }));
  await expect(createTestSessionApi(fence.sessionId, userId, vi.fn()).archiveContent(fence.sessionId, new AbortController().signal)).rejects.toThrow();
  expect(delivered).toBeGreaterThan(limit);
  expect(delivered).toBeLessThanOrEqual(limit + chunk.length);
  expect(cancelled).toHaveBeenCalledOnce();
}, 60_000);
