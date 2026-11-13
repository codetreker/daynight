import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionResource } from '../../daynight/src/session/protocol';
import { sessionImageBytes } from './helpers/sessionImages';
import { SessionImageStore, type ImageScopeIdentity } from '../src/features/task-agent-session/images/image-store';

const png = sessionImageBytes('png');
const identity: ImageScopeIdentity = { serverOrigin: 'https://daynight.test', actorUserId: '00000001-1111-4111-8111-111111111111', owner: { kind: 'session', fence: { sessionId: '00000002-1111-4111-8111-111111111111', claimId: '00000003-1111-4111-8111-111111111111', executionGeneration: '1' }, nativeSessionId: 'native' }, authorizationGeneration: '1' };
const signal = () => new AbortController().signal;
async function sample(id = '00000004-1111-4111-8111-111111111111', bytes: Uint8Array<ArrayBuffer> = png): Promise<{ descriptor: SessionResource; blob: Blob }> {
  const blob = await new Response(bytes).blob();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { blob, descriptor: { resourceId: id, revision: '1', name: 'sample.png', status: 'available', mediaType: 'image/png', byteLength: String(bytes.length), sha256: hash, width: 1, height: 1, frameCount: 1, error: null } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res; }); return { promise, resolve }; }
const stores: SessionImageStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
function store() { const value = new SessionImageStore(); stores.push(value); return value; }

describe('shared Session image originals', () => {
  it('synchronously notifies a preview that subscribes after its asset was removed', async () => {
    const value = await sample(), images = store();
    const scope = images.createScope({ identity, read: async () => value.blob, canRead: () => true, canDownload: () => true }), asset = scope.asset(value.descriptor)!;
    scope.retainResources(new Set());
    const invalidated = vi.fn(), unsubscribe = asset.subscribeInvalidation(invalidated);
    expect(invalidated).toHaveBeenCalledOnce(); expect(scope.valid).toBe(true);
    unsubscribe(); await scope.invalidate(); expect(invalidated).toHaveBeenCalledOnce();
  });
  it('retains referenced leases and revokes removed assets before allowing a fresh occurrence', async () => {
    const value = await sample(), images = store(), read = vi.fn(async () => value.blob);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close() {} })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:retained').mockReturnValueOnce('blob:removed');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const resource = { ...value.descriptor, width: 3, height: 2 }, other = { ...resource, resourceId: '00000005-1111-4111-8111-111111111111' };
    const kept = scope.asset(resource)!, removed = scope.asset(other)!, invalidated = vi.fn(); removed.subscribeInvalidation(invalidated);
    const keptLease = await kept.acquire(signal()), removedLease = await removed.acquire(signal());
    const keptPixels = await keptLease.decode(signal()), removedPixels = await removedLease.decode(signal());
    scope.retainResources(new Set([resource.resourceId, other.resourceId]));
    expect(keptLease.valid && removedLease.valid).toBe(true);
    scope.retainResources(new Set([resource.resourceId]));
    expect(keptLease.valid && keptPixels.valid).toBe(true); expect(scope.valid).toBe(true);
    expect(removed.canRead()).toBe(false); expect(removedLease.valid).toBe(false); expect(removedPixels.valid).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:removed'); expect(revoke).not.toHaveBeenCalledWith('blob:retained');
    const restored = scope.asset(other)!;
    expect(restored).not.toBe(removed); expect(restored.key).not.toBe(removed.key);
    (await restored.acquire(signal())).release(); expect(read).toHaveBeenCalledTimes(3);
    keptPixels.release(); keptLease.release();
  });
  it('keeps a removed reader charged while a fresh occurrence of the same original completes', async () => {
    const value = await sample(), images = store(), waiting = deferred<Blob>();
    const read = vi.fn((_id: string, _signal: AbortSignal) => waiting.promise).mockImplementationOnce((_id, _signal) => waiting.promise).mockImplementationOnce(async () => value.blob);
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true }), old = scope.asset(value.descriptor)!;
    const pending = old.acquire(signal()), rejected = expect(pending).rejects.toMatchObject({ code: 'access_revoked' });
    scope.retainResources(new Set());
    expect(read.mock.calls[0]![1].aborted).toBe(true); expect(images.usage().bytes).toBe(png.length * 2);
    const fresh = scope.asset(value.descriptor)!, lease = await fresh.acquire(signal());
    expect(lease.valid).toBe(true); expect(images.usage().bytes).toBe(png.length * 3);
    waiting.resolve(value.blob); await rejected;
    await vi.waitFor(() => expect(images.usage().bytes).toBe(png.length));
    expect(lease.valid).toBe(true); lease.release();
  });
  it('coalesces reads across occurrences and retains a verified original after consumers release it', async () => {
    const value = await sample(), read = vi.fn(async () => value.blob), images = store();
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const asset = scope.asset(value.descriptor)!;
    expect(scope.asset({ ...value.descriptor })).toBe(asset);
    const [first, second] = await Promise.all([asset.acquire(signal()), asset.acquire(signal())]);
    expect(first.blob).toBe(second.blob);
    expect(read).toHaveBeenCalledTimes(1);
    first.release(); second.release();
    const third = await asset.acquire(signal(), 'preview');
    expect(third.sha256).toBe(value.descriptor.sha256);
    expect(read).toHaveBeenCalledTimes(1);
    third.release();
  });

  it('does not share bytes between authenticated scopes with the same resource ID', async () => {
    const value = await sample(), read = vi.fn(async () => value.blob), images = store();
    const a = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const b = images.createScope({ identity: { ...identity, actorUserId: '00000005-1111-4111-8111-111111111111' }, read, canRead: () => true, canDownload: () => true });
    const leases = await Promise.all([a.asset(value.descriptor)!.acquire(signal()), b.asset(value.descriptor)!.acquire(signal())]);
    expect(read).toHaveBeenCalledTimes(2);
    leases.forEach(lease => lease.release());
  });

  it('keeps another waiter alive when only one occurrence is cancelled', async () => {
    const value = await sample(), waiting = deferred<Blob>(), read = vi.fn((_id: string, _signal: AbortSignal) => waiting.promise), images = store();
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true }), asset = scope.asset(value.descriptor)!;
    const first = new AbortController();
    const abandoned = asset.acquire(first.signal), survivor = asset.acquire(signal());
    const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    first.abort();
    expect(read.mock.calls[0]![1].aborted).toBe(false);
    waiting.resolve(value.blob);
    await rejected;
    (await survivor).release();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('coalesces new consumers after an abandoned reader drains without inheriting its cancellation', async () => {
    const value = await sample(), images = store(), waiting = deferred<Blob>();
    const read = vi.fn(async (_id: string, _signal: AbortSignal) => value.blob).mockImplementationOnce(() => waiting.promise);
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true }), asset = scope.asset(value.descriptor)!;
    const first = new AbortController(), next = new AbortController();
    const abandoned = asset.acquire(first.signal), rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    first.abort();
    let settled = false;
    const replacement = Promise.all([asset.acquire(next.signal), asset.acquire(next.signal, 'preview')]).then(leases => { settled = true; return leases; });
    try {
      await rejected; await Promise.resolve();
      expect(settled).toBe(false); expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]![1].aborted).toBe(true);
      expect(images.usage().bytes).toBe(png.length * 2);
      waiting.resolve(value.blob);
      const leases = await replacement;
      expect(read).toHaveBeenCalledTimes(2);
      expect(leases[0]!.blob).toBe(leases[1]!.blob);
      expect(leases.every(lease => lease.valid && lease.sha256 === value.descriptor.sha256)).toBe(true);
      expect(images.usage().bytes).toBe(png.length);
      leases.forEach(lease => lease.release());
    } finally { next.abort(); waiting.resolve(value.blob); await Promise.allSettled([abandoned, replacement]); }
  });

  it.each(['consumer', 'scope', 'asset', 'permission'] as const)('does not restart a draining read after %s access ends', async kind => {
    const value = await sample(), images = store(), waiting = deferred<Blob>(); let allowed = true;
    const read = vi.fn(async (_id: string, _signal: AbortSignal) => value.blob).mockImplementationOnce(() => waiting.promise);
    const scope = images.createScope({ identity, read, canRead: () => allowed, canDownload: () => allowed }), asset = scope.asset(value.descriptor)!;
    const first = new AbortController(), next = new AbortController();
    const abandoned = asset.acquire(first.signal), abandonedResult = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    first.abort();
    const replacement = asset.acquire(next.signal);
    const rejected = expect(replacement).rejects.toMatchObject(kind === 'consumer' ? { name: 'AbortError' } : { code: kind === 'permission' ? 'access_pending' : 'access_revoked' });
    let closed: Promise<void> | undefined;
    try {
      if (kind === 'consumer') next.abort();
      else if (kind === 'scope') closed = scope.invalidate();
      else if (kind === 'asset') scope.retainResources(new Set());
      else allowed = false;
      if (kind !== 'permission') await rejected;
      expect(read).toHaveBeenCalledTimes(1); expect(images.usage().bytes).toBe(png.length * 2);
      waiting.resolve(value.blob);
      await Promise.all([abandonedResult, rejected, closed]);
      expect(read).toHaveBeenCalledTimes(1); expect(images.usage().bytes).toBe(0);
    } finally { next.abort(); waiting.resolve(value.blob); await Promise.allSettled([abandoned, replacement, closed]); }
  });

  it('invalidates synchronously but keeps reservations until a cancelled reader actually ends', async () => {
    const value = await sample(), waiting = deferred<Blob>(), read = vi.fn((_id: string, _signal: AbortSignal) => waiting.promise), images = store();
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true }), asset = scope.asset(value.descriptor)!;
    const invalidated = vi.fn(); asset.subscribeInvalidation(invalidated);
    const pending = asset.acquire(signal());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'access_revoked' });
    const before = images.usage();
    let drained = false;
    const closed = scope.invalidate().then(() => { drained = true; });
    expect(asset.canRead()).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    expect(images.usage().bytes).toBe(before.bytes);
    await Promise.resolve(); expect(drained).toBe(false);
    waiting.resolve(value.blob);
    await Promise.all([closed, rejected]);
    expect(images.usage().bytes).toBe(0);
    expect(images.usage().items).toBe(0);
  });

  it('rejects forged formats and mismatched length or digest without publishing a Blob URL', async () => {
    const images = store(), create = vi.spyOn(URL, 'createObjectURL');
    const value = await sample();
    for (const [descriptor, blob] of [
      [{ ...value.descriptor, byteLength: String(png.length + 1) }, value.blob],
      [{ ...value.descriptor, sha256: '0'.repeat(64) }, value.blob],
      [value.descriptor, await new Response('<svg onload="alert(1)"/>').blob()],
    ] as const) {
      const scope = images.createScope({ identity, read: async () => blob, canRead: () => true, canDownload: () => true });
      await expect(scope.asset(descriptor)!.acquire(signal())).rejects.toMatchObject({ code: 'integrity_failed' });
      await scope.invalidate();
    }
    const svg = await sample(undefined, new TextEncoder().encode('<svg onload="alert(1)"/>'));
    const scope = images.createScope({ identity, read: async () => svg.blob, canRead: () => true, canDownload: () => true });
    await expect(scope.asset(svg.descriptor)!.acquire(signal())).rejects.toMatchObject({ code: 'unsupported_format' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a changed immutable descriptor and revokes the existing asset', async () => {
    const value = await sample(), images = store();
    const scope = images.createScope({ identity, read: async () => value.blob, canRead: () => true, canDownload: () => true });
    const asset = scope.asset(value.descriptor)!;
    const lease = await asset.acquire(signal());
    expect(() => scope.asset({ ...value.descriptor, revision: '2', sha256: 'a'.repeat(64) })).toThrow();
    expect(asset.canRead()).toBe(false);
    expect(lease.valid).toBe(false);
    lease.release();
  });
  it('can recover the canonical descriptor after a conflict without reviving an old lease or admitting changed bytes', async () => {
    const value = await sample(), images = store(), read = vi.fn(async () => value.blob);
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const old = scope.asset(value.descriptor)!, lease = await old.acquire(signal());
    const conflict = { ...value.descriptor, sha256: '0'.repeat(64) };
    expect(() => scope.asset(conflict)).toThrow(); expect(() => scope.asset(conflict)).toThrow();
    const restored = scope.asset(value.descriptor)!;
    expect(restored).not.toBe(old); expect(restored.key).not.toBe(old.key); expect(lease.valid).toBe(false);
    const recovered = await restored.acquire(signal()); expect(recovered.valid).toBe(true); expect(read).toHaveBeenCalledTimes(2);
    scope.retainResources(new Set());
    expect(recovered.valid).toBe(false); expect(() => scope.asset(conflict)).toThrow();
    const reappeared = scope.asset(value.descriptor)!;
    expect(reappeared.canRead()).toBe(true); expect(lease.valid).toBe(false); expect(recovered.valid).toBe(false);
  });

  it('freezes new acquisitions during permission checks without discarding existing bytes', async () => {
    const value = await sample(), images = store(), read = vi.fn(async () => value.blob); let admitted = true;
    const scope = images.createScope({ identity, read, canRead: () => admitted, canDownload: () => admitted }), asset = scope.asset(value.descriptor)!;
    const lease = await asset.acquire(signal());
    admitted = false;
    await expect(asset.acquire(signal())).rejects.toMatchObject({ code: 'access_pending' });
    expect(lease.valid).toBe(true);
    admitted = true;
    const reused = await asset.acquire(signal());
    expect(read).toHaveBeenCalledOnce();
    lease.release(); reused.release();
  });

  it('refuses oversized descriptors before requesting bytes', async () => {
    const value = await sample(), images = store(), read = vi.fn();
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    expect(scope.asset({ ...value.descriptor, byteLength: '10485761' })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('image admission and lifetime budgets', () => {
  async function filledBackground(count = 14) {
    const value = await sample(), images = store(), read = vi.fn((_id: string, _signal: AbortSignal) => Promise.resolve(value.blob));
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const asset = (n: number) => scope.asset({ ...value.descriptor, resourceId: `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, width: 3, height: 2 })!;
    const background = await Promise.all(Array.from({ length: count }, (_, n) => asset(n + 10).acquire(signal())));
    return { value, images, read, scope, asset, background };
  }

  it.each([['preview', 'download'], ['download', 'preview']] as const)('returns the %s slot when a shared original retains only its %s lease', async (first, remaining) => {
    const { images, read, asset, background } = await filledBackground();
    const original = asset(100), firstLease = await original.acquire(signal(), first), retained = await original.acquire(signal(), remaining);
    firstLease.release();
    const next = asset(101).acquire(signal(), first); void next.catch(() => {});
    expect(read).toHaveBeenCalledTimes(16);
    const admitted = await next;
    expect(retained.valid && admitted.valid && background.every(lease => lease.valid)).toBe(true);
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 0 });
  });

  it.each([['preview', 'download'], ['download', 'preview']] as const)('keeps a shared %s original charged while the remaining %s slot is occupied', async (first, remaining) => {
    const { images, read, asset, background } = await filledBackground();
    const original = asset(100), firstLease = await original.acquire(signal(), first), retained = await original.acquire(signal(), remaining);
    const blocker = await asset(101).acquire(signal(), remaining);
    const next = asset(102).acquire(signal(), first); void next.catch(() => {});
    firstLease.release();
    expect(read).toHaveBeenCalledTimes(16);
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 1 });
    expect(retained.valid && blocker.valid && background.every(lease => lease.valid)).toBe(true);
    blocker.release();
    expect(read).toHaveBeenCalledTimes(17);
    expect((await next).valid && retained.valid).toBe(true);
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 0 });
  });

  it('uses available background capacity when a shared original cannot move into the occupied download slot', async () => {
    const { images, read, asset, background } = await filledBackground(13);
    const original = asset(100), preview = await original.acquire(signal(), 'preview'), download = await original.acquire(signal(), 'download');
    const otherDownload = await asset(101).acquire(signal(), 'download');
    preview.release();
    const next = asset(102).acquire(signal(), 'preview'); void next.catch(() => {});
    expect(read).toHaveBeenCalledTimes(16);
    expect((await next).valid && download.valid && otherDownload.valid && background.every(lease => lease.valid)).toBe(true);
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 0 });
  });

  it('coordinates two shared originals whose remaining foreground operations exchange slots', async () => {
    const { images, read, asset } = await filledBackground();
    const a = asset(100), b = asset(101);
    const aPreview = await a.acquire(signal(), 'preview'), bDownload = await b.acquire(signal(), 'download');
    const aDownload = await a.acquire(signal(), 'download'), bPreview = await b.acquire(signal(), 'preview');
    aPreview.release(); bDownload.release();
    const next = asset(102).acquire(signal(), 'download'); void next.catch(() => {});
    expect(aDownload.valid && bPreview.valid).toBe(true);
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 1 });
    aDownload.release();
    expect(read).toHaveBeenCalledTimes(17);
    expect((await next).valid && bPreview.valid).toBe(true);
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 0 });
  });

  it.each([['preview', 'download'], ['download', 'preview']] as const)('restores a queued %s original after its shared %s waiter is cancelled', async (first, cancelled) => {
    const { images, read, asset } = await filledBackground();
    const firstBlocker = await asset(100).acquire(signal(), first), otherBlocker = await asset(101).acquire(signal(), cancelled);
    const original = asset(102), cancellation = new AbortController();
    const pending = original.acquire(signal(), first); void pending.catch(() => {});
    const rejected = expect(original.acquire(cancellation.signal, cancelled)).rejects.toMatchObject({ name: 'AbortError' });
    cancellation.abort(); await rejected;
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 1 });
    firstBlocker.release();
    expect(read).toHaveBeenCalledTimes(17);
    expect((await pending).valid && otherBlocker.valid).toBe(true);
    expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 0 });
  });

  it('moves an active read to available background capacity when its only foreground waiter is cancelled', async () => {
    const { value, images, read, scope, asset } = await filledBackground(13), waiting = deferred<Blob>();
    const original = asset(100), cancellation = new AbortController();
    read.mockImplementation((id: string, _signal: AbortSignal) => id === original.resource!.resourceId ? waiting.promise : Promise.resolve(value.blob));
    const rejected = expect(original.acquire(cancellation.signal, 'preview')).rejects.toMatchObject({ name: 'AbortError' });
    const pending = original.acquire(signal()); void pending.catch(() => {});
    try {
      cancellation.abort(); await rejected;
      const next = asset(101).acquire(signal(), 'preview'); void next.catch(() => {});
      expect(read).toHaveBeenCalledTimes(15);
      expect((await next).valid).toBe(true);
      expect(images.usage()).toMatchObject({ bytes: 1520, items: 15, queued: 0 });
      expect(read.mock.calls[13]![1].aborted).toBe(false);
      waiting.resolve(value.blob);
      expect((await pending).valid).toBe(true);
      expect(images.usage()).toMatchObject({ bytes: 1425, items: 15, queued: 0 });
    } finally { waiting.resolve(value.blob); await scope.invalidate(); await rejected; }
  });

  it.each([['preview', 'download'], ['download', 'preview']] as const)('returns a cancelled %s waiter slot but charges the remaining %s read until it actually stops', async (first, remaining) => {
    const { value, images, read, scope, asset } = await filledBackground(), waiting = deferred<Blob>();
    const original = asset(100), firstRequest = new AbortController(), retainedRequest = new AbortController();
    read.mockImplementation((id: string, _signal: AbortSignal) => id === original.resource!.resourceId ? waiting.promise : Promise.resolve(value.blob));
    const firstPending = original.acquire(firstRequest.signal, first), retainedPending = original.acquire(retainedRequest.signal, remaining);
    const firstRejected = expect(firstPending).rejects.toMatchObject({ name: 'AbortError' });
    const retainedRejected = expect(retainedPending).rejects.toMatchObject({ name: 'AbortError' });
    try {
      firstRequest.abort(); await firstRejected;
      const next = asset(101).acquire(signal(), first); void next.catch(() => {});
      expect(read).toHaveBeenCalledTimes(16);
      expect((await next).valid).toBe(true);
      expect(images.usage()).toMatchObject({ bytes: 1615, items: 16, queued: 0 });
      retainedRequest.abort(); await retainedRejected;
      expect(read.mock.calls[14]![1].aborted).toBe(true);
      const afterCancellation = asset(102).acquire(signal(), remaining); void afterCancellation.catch(() => {});
      expect(read).toHaveBeenCalledTimes(16);
      expect(images.usage()).toMatchObject({ bytes: 1615, items: 16, queued: 1 });
      waiting.resolve(value.blob);
      expect((await afterCancellation).valid).toBe(true);
      expect(read).toHaveBeenCalledTimes(17);
      expect(images.usage()).toMatchObject({ bytes: 1520, items: 16, queued: 0 });
    } finally {
      retainedRequest.abort(); waiting.resolve(value.blob); await scope.invalidate();
      await Promise.all([firstRejected, retainedRejected]);
    }
  });

  it.each([
    { remaining: 'download', background: 14, bytes: 1520, items: 16 },
    { remaining: 'background', background: 13, bytes: 1425, items: 15 },
  ] as const)('changes the original reservation to $remaining while a cancelled decoder keeps both byte budgets charged', async ({ remaining, background, bytes, items }) => {
    const { images, read, scope, asset } = await filledBackground(background);
    const bitmap = deferred<{ width: number; height: number; close(): void }>(), close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(() => bitmap.promise));
    const original = asset(100), preview = await original.acquire(signal(), 'preview'), retained = await original.acquire(signal(), remaining);
    const decoding = preview.decode(signal()), rejected = expect(decoding).rejects.toMatchObject({ name: 'AbortError' });
    try {
      preview.release();
      const next = asset(101).acquire(signal(), 'preview'); void next.catch(() => {});
      expect(read).toHaveBeenCalledTimes(items);
      expect((await next).valid && retained.valid).toBe(true);
      expect(images.usage()).toMatchObject({ bytes, items, decoded: { bytes: 24, running: 1 } });
      retained.release();
      const afterCancellation = asset(102).acquire(signal(), remaining); void afterCancellation.catch(() => {});
      expect(images.usage()).toMatchObject({ bytes, items, queued: 1, decoded: { bytes: 24, running: 1 } });
      bitmap.resolve({ width: 3, height: 2, close }); await rejected;
      expect((await afterCancellation).valid).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      expect(images.usage()).toMatchObject({ bytes, items, queued: 0, decoded: { bytes: 0, running: 0 } });
    } finally {
      bitmap.resolve({ width: 3, height: 2, close }); await scope.invalidate(); await rejected;
    }
  });

  it('reserves an independent preview and download while a background original is still reading', async () => {
    const value = await sample(), images = store(), waiting = deferred<Blob>();
    const read = vi.fn((_id: string, _signal: AbortSignal) => waiting.promise);
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const asset = (n: number) => scope.asset({ ...value.descriptor, resourceId: `0000000${n}-1111-4111-8111-111111111111`, byteLength: '10485760' })!;
    const requests = [asset(4).acquire(signal()), asset(5).acquire(signal()), asset(6).acquire(signal(), 'preview'), asset(7).acquire(signal(), 'download')];
    const settled = Promise.allSettled(requests);
    expect(read).toHaveBeenCalledTimes(3);
    expect(images.usage()).toMatchObject({ bytes: 60 * 1_048_576, items: 3, queued: 1 });
    const close = scope.invalidate();
    expect(images.usage().bytes).toBe(60 * 1_048_576);
    waiting.resolve(value.blob);
    await close; await settled;
    expect(images.usage()).toMatchObject({ bytes: 0, items: 0, queued: 0 });
  });

  it('evicts unleased originals after five minutes without affecting a live lease', async () => {
    vi.useFakeTimers();
    const value = await sample(), images = store(), read = vi.fn(async () => value.blob);
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const asset = scope.asset(value.descriptor)!;
    const lease = await asset.acquire(signal());
    await vi.advanceTimersByTimeAsync(300_001);
    expect(lease.valid).toBe(true); expect(images.usage().items).toBe(1);
    lease.release();
    await vi.advanceTimersByTimeAsync(300_001);
    expect(images.usage().items).toBe(0);
    (await asset.acquire(signal())).release(); expect(read).toHaveBeenCalledTimes(2);
  });

  it('resets the idle deadline on real reader progress and retains the reservation until timeout drains', async () => {
    vi.useFakeTimers();
    const value = await sample(), images = store(), waiting = deferred<Blob>(); let progress!: () => void;
    const read = vi.fn((_id: string, _signal: AbortSignal, onProgress?: () => void) => { progress = onProgress!; return waiting.promise; });
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const pending = scope.asset(value.descriptor)!.acquire(signal());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'read_timeout' });
    await vi.advanceTimersByTimeAsync(14_000); progress();
    await vi.advanceTimersByTimeAsync(14_000); expect(read.mock.calls[0]![1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001); expect(read.mock.calls[0]![1].aborted).toBe(true);
    expect(images.usage().bytes).toBe(png.length * 2);
    waiting.resolve(value.blob); await rejected; await scope.invalidate();
    expect(images.usage().bytes).toBe(0);
  });
});

describe('foreground queue reservation', () => {
  it('admits a preview even when all background wait slots are occupied', async () => {
    const value = await sample(), images = store(), waiting = deferred<Blob>();
    const read = vi.fn((_id: string, _signal: AbortSignal) => waiting.promise);
    const scope = images.createScope({ identity, read, canRead: () => true, canDownload: () => true });
    const asset = (n: number) => scope.asset({ ...value.descriptor, resourceId: `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, byteLength: '10485760' })!;
    const background = Array.from({ length: 33 }, (_, n) => asset(n + 10).acquire(signal()));
    const settled = Promise.allSettled(background);
    expect(images.usage().queued).toBe(32);
    const foreground = asset(100).acquire(signal(), 'preview'), previewSettled = Promise.allSettled([foreground]);
    expect(read).toHaveBeenCalledTimes(2);
    const closed = scope.invalidate(); waiting.resolve(value.blob); await closed; await settled; await previewSettled;
    expect(images.usage()).toMatchObject({ bytes: 0, items: 0, queued: 0 });
  });
});
