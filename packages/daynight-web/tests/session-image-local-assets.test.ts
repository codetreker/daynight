import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionImageStore, type ImageScopeIdentity } from '../src/features/task-agent-session/images/image-store';
import { sessionAnimatedImageSamples, sessionImageBytes } from './helpers/sessionImages';

const identity: ImageScopeIdentity = { serverOrigin: 'https://daynight.test', actorUserId: 'owner', authorizationGeneration: '1', owner: { kind: 'session', fence: { sessionId: '00000002-1111-4111-8111-111111111111', claimId: '00000003-1111-4111-8111-111111111111', executionGeneration: '1' }, nativeSessionId: 'native' } };
const stores: SessionImageStore[] = [];
const signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res; }); return { promise, resolve }; }
async function blob(format: 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' = 'png', type = `image/${format}`) {
  return new Response(sessionImageBytes(format), { headers: { 'Content-Type': type } }).blob();
}
function fixture() {
  const images = new SessionImageStore(); stores.push(images);
  const read = vi.fn<() => Promise<Blob>>(async () => { throw new Error('Local originals do not use the network.'); });
  const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
  return { images, scope, read };
}
beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close() {} })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(async () => { await Promise.all(stores.splice(0).map(images => images.close())); });

describe('local Session image assets', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('verifies %s originals in the existing owner without a service descriptor or request', async format => {
    const { images, scope, read } = fixture(), original = await blob(format);
    const asset = images.createLocalAsset(scope, { key: 'draft/image/1', blob: original });
    expect(asset.scope).toBe(scope); expect(asset.resource).toBeNull(); expect(asset.metadata).toBeNull();
    const metadata = await asset.validate(signal());
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await original.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(metadata).toEqual({ mediaType: `image/${format}`, byteLength: original.size, sha256, width: 3, height: 2, frameCount: 1 });
    expect(asset.metadata).toBe(metadata); expect(Object.isFrozen(metadata)).toBe(true);
    expect(images.createLocalAsset(scope, { key: 'draft/image/1', blob: original })).toBe(asset);
    const [frame, preview] = await Promise.all([asset.acquire(signal()), asset.acquire(signal(), 'preview')]);
    expect(frame.blob).toBe(preview.blob); expect(frame.storedSize).toEqual({ width: 3, height: 2 });
    expect(images.usage()).toMatchObject({ bytes: original.size, items: 1, decoded: { bytes: 0, running: 0 } });
    expect(createImageBitmap).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    frame.release(); preview.release();
  });

  it('detects an absent MIME from bytes but refuses a conflicting declared MIME', async () => {
    const { images, scope } = fixture();
    expect((await images.createLocalAsset(scope, { key: 'empty-mime', blob: await blob('png', '') }).validate(signal())).mediaType).toBe('image/png');
    await expect(images.createLocalAsset(scope, { key: 'wrong-mime', blob: await blob('png', 'image/jpeg') }).validate(signal())).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  it('refuses oversized, empty and unsupported candidates before reading their bytes', async () => {
    const { images, scope } = fixture();
    const oversized = await blob(); Object.defineProperty(oversized, 'size', { value: 10 * 1_048_576 + 1 });
    for (const original of [oversized, await new Response('', { headers: { 'Content-Type': 'image/png' } }).blob(), await blob('gif'), await blob('avif')]) {
      const read = vi.spyOn(original, 'arrayBuffer');
      expect(() => images.createLocalAsset(scope, { key: 'invalid', blob: original })).toThrow();
      expect(read).not.toHaveBeenCalled();
    }
    expect(images.usage()).toMatchObject({ bytes: 0, items: 0 }); expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('checks recovered metadata against actual bytes before admitting local pixels', async () => {
    const { images, scope } = fixture(), original = await blob();
    const asset = images.createLocalAsset(scope, { key: 'restored', blob: original, metadata: { mediaType: 'image/png', byteLength: original.size, sha256: '0'.repeat(64), width: 3, height: 2, frameCount: 1 } });
    await expect(asset.validate(signal())).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(asset.metadata).toBeNull(); expect(createImageBitmap).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects truncated containers even when their length and hash can be calculated', async () => {
    const { images, scope } = fixture(), original = await blob();
    const asset = images.createLocalAsset(scope, { key: 'truncated', blob: original.slice(0, original.size - 1, original.type) });
    await expect(asset.validate(signal())).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(asset.metadata).toBeNull(); expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('validates all animation frames and never publishes an incomplete animation', async () => {
    const { images, scope } = fixture(), close = vi.fn(), frameClose = vi.fn();
    const decode = vi.fn(async ({ frameIndex }: { frameIndex: number }) => {
      if (frameIndex === 1) throw new Error('Corrupt second frame');
      return { image: { displayWidth: 3, displayHeight: 2, close: frameClose } };
    });
    class Decoder {
      static async isTypeSupported() { return true; }
      completed = Promise.resolve(); tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } }; decode = decode; close = close;
    }
    vi.stubGlobal('ImageDecoder', Decoder);
    const bytes = Uint8Array.from(atob(sessionAnimatedImageSamples.webp), value => value.charCodeAt(0));
    const original = await new Response(bytes, { headers: { 'Content-Type': 'image/webp' } }).blob();
    // JSDOM omits Blob.stream(); browser acceptance owns the actual codec.
    const slice = original.slice.bind(original);
    vi.spyOn(original, 'slice').mockImplementation((...args) => {
      const value = slice(...args); Object.defineProperty(value, 'stream', { value: () => new Response(bytes).body }); return value;
    });
    const asset = images.createLocalAsset(scope, { key: 'animated', blob: original });
    await expect(asset.validate(signal())).rejects.toMatchObject({ code: 'decode_failed' });
    expect(decode.mock.calls.map(([options]) => options.frameIndex)).toEqual([0, 1]);
    expect(close).toHaveBeenCalledOnce(); expect(frameClose).toHaveBeenCalledOnce();
    expect(asset.metadata).toBeNull(); expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('serializes local byte inspection and keeps a second consumer alive after cancellation', async () => {
    const { images, scope } = fixture(), firstBlob = await blob(), secondBlob = await blob('webp');
    const waiting = deferred<ArrayBuffer>(), started = deferred<void>();
    const firstRead = vi.spyOn(firstBlob, 'arrayBuffer').mockImplementation(() => { started.resolve(); return waiting.promise; });
    const secondRead = vi.spyOn(secondBlob, 'arrayBuffer');
    const first = images.createLocalAsset(scope, { key: 'first', blob: firstBlob }), second = images.createLocalAsset(scope, { key: 'second', blob: secondBlob });
    const cancelled = new AbortController(), rejection = expect(first.acquire(cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const survivor = first.acquire(signal()), following = second.acquire(signal());
    try {
      await started.promise; cancelled.abort(); await rejection;
      expect(firstRead).toHaveBeenCalledOnce(); expect(secondRead).not.toHaveBeenCalled();
    } finally { waiting.resolve(sessionImageBytes('png').buffer); }
    const firstLease = await survivor, secondLease = await following;
    expect(firstLease.mediaType).toBe('image/png'); expect(secondLease.mediaType).toBe('image/webp'); firstLease.release(); secondLease.release();
    expect(secondRead).toHaveBeenCalledOnce();
  });

  it('revokes local publication immediately but charges a cancelled decoder until it settles', async () => {
    const { images, scope } = fixture(), original = await blob(), waiting = deferred<{ width: number; height: number; close(): void }>(), started = deferred<void>();
    vi.mocked(createImageBitmap).mockImplementation(() => { started.resolve(); return waiting.promise as Promise<ImageBitmap>; });
    const asset = images.createLocalAsset(scope, { key: 'pending', blob: original });
    const rejection = expect(asset.validate(signal())).rejects.toMatchObject({ code: 'access_revoked' });
    await started.promise;
    let drained = false; const closing = scope.invalidate().then(() => { drained = true; });
    expect(asset.canRead()).toBe(false); expect(asset.metadata).toBeNull();
    expect(images.usage()).toMatchObject({ bytes: original.size * 2, decoded: { bytes: 24, running: 1 } });
    await Promise.resolve(); expect(drained).toBe(false);
    const close = vi.fn(); waiting.resolve({ width: 3, height: 2, close });
    await rejection; await closing;
    expect(close).toHaveBeenCalledOnce(); expect(images.usage()).toMatchObject({ bytes: 0, items: 0, decoded: { bytes: 0, running: 0 } });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('isolates explicit local removal from history reconciliation and other draft references', async () => {
    const { images, scope } = fixture(), original = await blob();
    const removed = images.createLocalAsset(scope, { key: 'editable', blob: original }), retained = images.createLocalAsset(scope, { key: 'unknown-submission', blob: original });
    const a = await removed.acquire(signal()), b = await retained.acquire(signal());
    const history = scope.asset({ resourceId: '00000005-1111-4111-8111-111111111111', revision: '1', name: 'saved.png', status: 'available', mediaType: 'image/png', byteLength: String(original.size), sha256: a.sha256, width: 3, height: 2, frameCount: 1, error: null })!;
    const historyInvalidated = vi.fn(); history.subscribeInvalidation(historyInvalidated);
    scope.retainResources(new Set([history.resource!.resourceId]));
    expect(a.valid && b.valid).toBe(true);
    const invalidated = vi.fn(); removed.subscribeInvalidation(invalidated); removed.release(); removed.release();
    expect(a.valid).toBe(false); expect(removed.metadata).toBeNull(); expect(invalidated).toHaveBeenCalledOnce();
    expect(b.valid && retained.canRead() && history.canRead()).toBe(true); expect(historyInvalidated).not.toHaveBeenCalled();
    scope.retainResources(new Set()); expect(historyInvalidated).toHaveBeenCalledOnce(); expect(b.valid).toBe(true);
    const late = vi.fn(); removed.subscribeInvalidation(late); expect(late).toHaveBeenCalledOnce();
    b.release();
  });

  it('validates behind occupied owner background slots and releases its temporary reservation', async () => {
    const { images, scope, read } = fixture(), original = await blob();
    read.mockImplementation(async () => original);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await original.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const history = await Promise.all(Array.from({ length: 14 }, (_, index) => scope.asset({ resourceId: `${String(index + 20).padStart(8, '0')}-1111-4111-8111-111111111111`, revision: '1', name: 'saved.png', status: 'available', mediaType: 'image/png', byteLength: String(original.size), sha256: hash, width: 3, height: 2, frameCount: 1, error: null })!.acquire(signal())));
    const asset = images.createLocalAsset(scope, { key: 'draft', blob: original });
    expect(images.usage()).toMatchObject({ items: 14, queued: 0 }); expect(createImageBitmap).not.toHaveBeenCalled();
    const metadata = await asset.validate(signal());
    expect(metadata.sha256).toBe(hash); expect(history.every(lease => lease.valid)).toBe(true);
    expect(images.usage()).toMatchObject({ bytes: original.size * 14, items: 14, queued: 0 }); expect(read).toHaveBeenCalledTimes(14);
    expect(createImageBitmap).toHaveBeenCalledOnce(); history.forEach(lease => lease.release());
  });

  it('promotes pending local validation when a preview opens behind occupied background decoding', async () => {
    const { images, scope, read } = fixture(), original = await blob(), started = deferred<void>();
    read.mockImplementation(async () => original);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await original.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const history = scope.asset({ resourceId: '00000005-1111-4111-8111-111111111111', revision: '1', name: 'large.png', status: 'available', mediaType: 'image/png', byteLength: String(original.size), sha256: hash, width: 8192, height: 4096, frameCount: 1, error: null })!;
    vi.mocked(createImageBitmap).mockResolvedValueOnce({ width: 8192, height: 4096, close() {} } as ImageBitmap);
    const held = await history.acquire(signal()), canvas = await held.decode(signal());
    const asset = images.createLocalAsset(scope, { key: 'preview-after-validation', blob: original });
    const inspection = original.arrayBuffer.bind(original);
    vi.spyOn(original, 'arrayBuffer').mockImplementation(async () => { const bytes = await inspection(); started.resolve(); return bytes; });
    const validating = asset.acquire(signal()); void validating.catch(() => {});
    await started.promise;
    await vi.waitFor(() => expect(images.usage().decoded.queued).toBe(1));
    const preview = asset.acquire(signal(), 'preview'); void preview.catch(() => {});
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(2));
    const validated = await validating; expect(validated.mediaType).toBe('image/png'); validated.release();
    const visible = await preview; expect(visible.valid && canvas.valid).toBe(true);
    visible.release(); canvas.release(); held.release();
  });

  it('pauses new reads during identity confirmation while keeping the validated owner lease', async () => {
    const images = new SessionImageStore(); stores.push(images); let admitted = true;
    const scope = images.createScope({ identity, read: vi.fn(), canRead: () => admitted, canDownload: () => admitted });
    const original = await blob(), asset = images.createLocalAsset(scope, { key: 'draft', blob: original });
    const lease = await asset.acquire(signal());
    admitted = false;
    expect(asset.canRead()).toBe(false); expect(asset.canDownload()).toBe(false); expect(lease.valid).toBe(true);
    await expect(asset.validate(signal())).rejects.toMatchObject({ code: 'access_pending' });
    expect(() => images.createLocalAsset(scope, { key: 'new', blob: original })).toThrow();
    admitted = true;
    expect(images.createLocalAsset(scope, { key: 'draft', blob: original })).toBe(asset);
    expect((await asset.validate(signal())).sha256).toBe(lease.sha256); expect(createImageBitmap).toHaveBeenCalledOnce();
    lease.release();
  });

  it('rejects invalid source geometry before any full pixel decode', async () => {
    const { images, scope } = fixture(), bytes = sessionImageBytes('jpeg');
    const marker = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xc0);
    expect(marker).toBeGreaterThan(0);
    new DataView(bytes.buffer).setUint16(marker + 7, 16_385);
    const original = await new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } }).blob();
    const asset = images.createLocalAsset(scope, { key: 'too-wide', blob: original });
    await expect(asset.validate(signal())).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(createImageBitmap).not.toHaveBeenCalled(); expect(asset.metadata).toBeNull();
  });

  it('rejects foreign, expired and record scopes instead of creating another owner', async () => {
    const { images, scope } = fixture(), other = fixture(), original = await blob();
    expect(() => images.createLocalAsset(other.scope, { key: 'foreign', blob: original })).toThrow();
    const record = images.createScope({ identity: { ...identity, owner: { kind: 'record', namespace: 'attachment', recordId: 'record', revision: '1' } }, read: vi.fn(), canRead: () => true, canDownload: () => true });
    expect(() => images.createLocalAsset(record, { key: 'record', blob: original })).toThrow();
    await scope.invalidate();
    expect(() => images.createLocalAsset(scope, { key: 'expired', blob: original })).toThrow();
  });

  it('rejects cached validation when the byte version is removed before its continuation', async () => {
    const { images, scope } = fixture(), original = await blob();
    const asset = images.createLocalAsset(scope, { key: 'removed-before-return', blob: original });
    await asset.validate(signal());
    const pending = asset.validate(signal());
    asset.release();
    await expect(pending).rejects.toMatchObject({ code: 'access_revoked' });
    expect(asset.metadata).toBeNull();
  });

});
