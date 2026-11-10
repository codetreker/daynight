import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionImageStore, type ImageScopeIdentity } from '../src/features/task-agent-session/images/image-store';
import { verifyImageContainer } from '../src/features/task-agent-session/images/image-format';
import { ImageDecodePool } from '../src/features/task-agent-session/images/image-decode';
import { sessionAnimatedImageSamples, sessionImageBytes } from './helpers/sessionImages';
import type { DisplayMime, SessionResource } from '../../daynight/src/session/protocol';
const identity: ImageScopeIdentity = { serverOrigin: 'https://daynight.test', actorUserId: '00000001-1111-4111-8111-111111111111', owner: { kind: 'record', recordId: 'record', namespace: 'task-attachment', revision: '1' }, authorizationGeneration: '1' };
const stores: SessionImageStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
async function loaded(bytes = sessionImageBytes('png'), mediaType: DisplayMime = 'image/png', frameCount = 1, legacy = false) {
  const images = new SessionImageStore(); stores.push(images);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const blob = await new Response(bytes).blob(), read = vi.fn(async () => blob);
  const descriptor: SessionResource = { resourceId: '00000004-1111-4111-8111-111111111111', ...(!legacy ? { revision: '1', width: 3, height: 2, frameCount } : {}), name: 'image.png', mediaType, status: 'available', byteLength: String(bytes.length), sha256: digest, error: null };
  const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
  const lease = await scope.asset(descriptor)!.acquire(new AbortController().signal);
  return { lease, scope, images, read };
}

describe('image containers', () => {
  it.each(['png', 'jpeg', 'gif', 'webp', 'avif'] as const)('accepts a real %s file and rejects a truncated container', (format) => {
    const bytes = sessionImageBytes(format), mime = `image/${format}` as DisplayMime;
    expect(() => verifyImageContainer(bytes, mime)).not.toThrow();
    expect(() => verifyImageContainer(bytes.slice(0, -3), mime)).toThrow();
  });
  it('does not accept an SVG or HTML document labeled as any supported format', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const) {
      expect(() => verifyImageContainer(new TextEncoder().encode('<svg onload="alert(1)"/>'), mime)).toThrow();
      expect(() => verifyImageContainer(new TextEncoder().encode('<html>image</html>'), mime)).toThrow();
    }
  });
});

describe('browser decode ownership', () => {
  it('keeps verified originals available for download after a local decoder failure', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('Unsupported codec'); }));
    const { lease, read, images } = await loaded();
    await expect(lease.decode(new AbortController().signal)).rejects.toMatchObject({ code: 'decode_failed' });
    expect(lease.valid).toBe(true); expect(lease.blob.size).toBeGreaterThan(0); expect(read).toHaveBeenCalledOnce();
    expect(images.usage().decoded.bytes).toBe(0);
    lease.release();
  });
  it('revokes decoded URLs immediately when the scope loses permission', async () => {
    const close = vi.fn(); vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decoded'); const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { lease, scope, images } = await loaded();
    const decoded = await lease.decode(new AbortController().signal), invalidated = vi.fn(); decoded.subscribeInvalidation(invalidated);
    expect(decoded).toMatchObject({ width: 3, height: 2, url: 'blob:decoded', valid: true });
    expect(images.usage().decoded.bytes).toBe(24);
    const draining = scope.invalidate();
    expect(decoded.valid).toBe(false); expect(revoke).toHaveBeenCalledWith('blob:decoded'); expect(invalidated).toHaveBeenCalledOnce();
    await draining; expect(close).toHaveBeenCalledOnce(); expect(images.usage().decoded.bytes).toBe(0);
  });
  it('waits for a non-cancellable browser decoder before returning both original and canvas reservations', async () => {
    let complete!: (value: { width: number; height: number; close(): void }) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { complete = resolve; })));
    const { lease, scope, images } = await loaded();
    const decoding = lease.decode(new AbortController().signal);
    const rejected = expect(decoding).rejects.toMatchObject({ code: 'access_revoked' });
    let drained = false; const closing = scope.invalidate().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false); expect(images.usage().bytes).toBe(lease.byteLength); expect(images.usage().decoded.bytes).toBe(24);
    const close = vi.fn(); complete({ width: 3, height: 2, close });
    await rejected; await closing;
    expect(close).toHaveBeenCalledOnce(); expect(images.usage().bytes).toBe(0); expect(images.usage().decoded.bytes).toBe(0);
  });
});

describe('decode task admission and complete frames', () => {
  it.each(['png', 'jpeg', 'gif', 'webp', 'avif'] as const)('uses verified legacy %s canvas dimensions so a second small image can decode', async format => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close() {} })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:legacy'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { lease, images } = await loaded(sessionImageBytes(format), `image/${format}`, 1, true);
    expect(lease.storedSize).toEqual({ width: 3, height: 2 });
    const first = await lease.decode(new AbortController().signal), second = await lease.decode(new AbortController().signal);
    expect(images.usage().decoded.bytes).toBe(48); expect(first.valid).toBe(true); expect(second.valid).toBe(true);
    first.release(); second.release(); lease.release();
  });
  it('reserves the declared canvas during decoding then retains only the actual canvas', async () => {
    let finish!: (value: { width: number; height: number; close(): void }) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:small'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const pool = new ImageDecodePool(), blob = await new Response(sessionImageBytes('png')).blob();
    const pending = pool.acquire(blob, { width: 100, height: 100 }, new AbortController().signal, 'background', 1, true);
    expect(pool.usage().bytes).toBe(40_000); finish({ width: 3, height: 2, close() {} });
    const lease = await pending; expect(pool.usage().bytes).toBe(24);
    lease.release(); expect(pool.usage().bytes).toBe(0);
  });
  it('walks every animation frame and closes the decoder before publishing a URL', async () => {
    const close = vi.fn(), frames = [vi.fn(), vi.fn()];
    const decode = vi.fn(async ({ frameIndex }: { frameIndex: number }) => ({ image: { displayWidth: 3, displayHeight: 2, close: frames[frameIndex]! } }));
    class Decoder {
      static async isTypeSupported() { return true; }
      completed = Promise.resolve(); tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } }; decode = decode; close = close;
    }
    vi.stubGlobal('ImageDecoder', Decoder); const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { expect(close).toHaveBeenCalled(); return 'blob:animation'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const bytes = Uint8Array.from(atob(sessionAnimatedImageSamples.gif), value => value.charCodeAt(0));
    const { lease } = await loaded(bytes, 'image/gif', 2);
    // JSDOM's Blob omits stream(); the real browser suite owns decoder integration.
    Object.defineProperty(lease.blob, 'stream', { value: () => new Response(bytes).body });
    const result = await lease.decode(new AbortController().signal);
    expect(decode.mock.calls.map(([options]) => options.frameIndex)).toEqual([0, 1]);
    expect(frames.every(frame => frame.mock.calls.length === 1)).toBe(true); expect(create).toHaveBeenCalledOnce(); result.release(); lease.release();
  });
  it('retains the decode reservation after a timeout until a browser bitmap task settles', async () => {
    vi.useFakeTimers(); let complete!: (value: { width: number; height: number; close(): void }) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { complete = resolve; })));
    const { lease, images } = await loaded(); let settled = false;
    const decoding = lease.decode(new AbortController().signal).finally(() => { settled = true; });
    const rejected = expect(decoding).rejects.toMatchObject({ code: 'decode_timeout' });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(settled).toBe(false); expect(images.usage().decoded).toMatchObject({ bytes: 24, running: 1 });
    complete({ width: 3, height: 2, close() {} }); await rejected;
    expect(images.usage().decoded.bytes).toBe(0); expect(lease.valid).toBe(true); lease.release();
  });
  it('reserves one decode task for a foreground preview while background work is queued', async () => {
    const complete: Array<(value: { width: number; height: number; close(): void }) => void> = [];
    const bitmap = vi.fn(() => new Promise(resolve => { complete.push(resolve); })); vi.stubGlobal('createImageBitmap', bitmap);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:canvas'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { lease, images } = await loaded();
    const a = lease.decode(new AbortController().signal), b = lease.decode(new AbortController().signal), preview = lease.decode(new AbortController().signal, 'preview');
    expect(bitmap).toHaveBeenCalledTimes(2); expect(images.usage().decoded).toMatchObject({ running: 2, queued: 1 });
    complete[0]!({ width: 3, height: 2, close() {} }); const first = await a;
    await vi.waitFor(() => expect(bitmap).toHaveBeenCalledTimes(3));
    complete[1]!({ width: 3, height: 2, close() {} }); complete[2]!({ width: 3, height: 2, close() {} });
    const [second, foreground] = await Promise.all([b, preview]);
    expect(images.usage().decoded.bytes).toBe(72);
    first.release(); second.release(); foreground.release(); lease.release(); expect(images.usage().decoded.bytes).toBe(0);
  });
});

describe('animation fallback', () => {
  it('does not trust a one-frame descriptor when an AVIF sequence container has unknown frame count', async () => {
    const bytes = sessionImageBytes('avif'); bytes.set(new TextEncoder().encode('avis'), 8);
    expect(verifyImageContainer(bytes, 'image/avif').frameCount).toBeNull();
    class Decoder {
      static async isTypeSupported() { return true; }
      completed = Promise.reject(new Error('Native sequence decoder failed'));
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 1 } }; decode = vi.fn(); close = vi.fn();
    }
    vi.stubGlobal('ImageDecoder', Decoder); const bitmap = vi.fn(); vi.stubGlobal('createImageBitmap', bitmap);
    const { lease } = await loaded(bytes, 'image/avif', 1);
    Object.defineProperty(lease.blob, 'stream', { value: () => new Response(bytes).body });
    await expect(lease.decode(new AbortController().signal)).rejects.toMatchObject({ code: 'decode_failed' });
    expect(bitmap).not.toHaveBeenCalled(); expect(lease.valid).toBe(true); lease.release();
  });
  it('uses the single-frame bitmap decoder after a native AVIF codec failure has closed', async () => {
    const close = vi.fn(), bitmapClose = vi.fn();
    class Decoder {
      static async isTypeSupported() { return true; }
      completed = Promise.reject(new DOMException('Aborted by close.', 'AbortError'));
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 1 } };
      decode = vi.fn(); close = close;
    }
    vi.stubGlobal('ImageDecoder', Decoder);
    const bitmap = vi.fn(async () => { expect(close).toHaveBeenCalledOnce(); return { width: 3, height: 2, close: bitmapClose }; });
    vi.stubGlobal('createImageBitmap', bitmap);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avif'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const bytes = sessionImageBytes('avif'), { lease } = await loaded(bytes, 'image/avif');
    Object.defineProperty(lease.blob, 'stream', { value: () => new Response(bytes).body });
    const decoded = await lease.decode(new AbortController().signal);
    expect(decoded).toMatchObject({ width: 3, height: 2, valid: true });
    expect(bitmap).toHaveBeenCalledOnce(); expect(bitmapClose).toHaveBeenCalledOnce(); decoded.release(); lease.release();
  });
  it('does not use bitmap fallback when a complete decoder contradicts the verified frame count', async () => {
    const close = vi.fn(), bitmap = vi.fn();
    class Decoder {
      static async isTypeSupported() { return true; }
      completed = Promise.resolve(); tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } }; decode = vi.fn(); close = close;
    }
    vi.stubGlobal('ImageDecoder', Decoder); vi.stubGlobal('createImageBitmap', bitmap);
    const bytes = sessionImageBytes('avif'), { lease } = await loaded(bytes, 'image/avif');
    Object.defineProperty(lease.blob, 'stream', { value: () => new Response(bytes).body });
    await expect(lease.decode(new AbortController().signal)).rejects.toMatchObject({ code: 'decode_failed' });
    expect(close).toHaveBeenCalledOnce(); expect(bitmap).not.toHaveBeenCalled(); lease.release();
  });
  it('does not start bitmap fallback after a caller cancels an active complete decoder', async () => {
    let reject!: (reason: unknown) => void;
    const close = vi.fn(() => reject(new DOMException('Aborted by close.', 'AbortError'))), bitmap = vi.fn();
    class Decoder {
      static async isTypeSupported() { return true; }
      completed = new Promise<void>((_resolve, fail) => { reject = fail; });
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 1 } }; decode = vi.fn(); close = close;
    }
    vi.stubGlobal('ImageDecoder', Decoder); vi.stubGlobal('createImageBitmap', bitmap);
    const bytes = sessionImageBytes('avif'), { lease } = await loaded(bytes, 'image/avif'), controller = new AbortController();
    Object.defineProperty(lease.blob, 'stream', { value: () => new Response(bytes).body });
    const decoding = lease.decode(controller.signal), rejected = expect(decoding).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(reject).toBeTypeOf('function')); controller.abort(); await rejected;
    expect(bitmap).not.toHaveBeenCalled(); lease.release();
  });
  it.each(['gif', 'webp'] as const)('counts complete %s frames and refuses first-frame-only fallback', async (format) => {
    const bytes = Uint8Array.from(atob(sessionAnimatedImageSamples[format]), value => value.charCodeAt(0)), mime = `image/${format}` as DisplayMime;
    expect(verifyImageContainer(bytes, mime).frameCount).toBe(2);
    const bitmap = vi.fn(); vi.stubGlobal('createImageBitmap', bitmap);
    const { lease } = await loaded(bytes, mime, 2);
    await expect(lease.decode(new AbortController().signal)).rejects.toMatchObject({ code: 'decode_failed' });
    expect(bitmap).not.toHaveBeenCalled(); expect(lease.valid).toBe(true); lease.release();
  });
});
