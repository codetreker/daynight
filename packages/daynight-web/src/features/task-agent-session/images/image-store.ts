import { sessionFenceKey, type SessionResource } from '../../../../../daynight/src/session/protocol';
import { ImageDecodePool } from './image-decode';
import { verifyImageContainer } from './image-format';
import { ImageFailure, isDisplayMime, type ImageAssetAdapter, type ImageReadPriority, type ImageScope, type ImageScopeIdentity, type ImageSize, type VerifiedImageLease } from './image-types';
export * from './image-types';

const MIB = 1_048_576, MAX_IMAGE = 10 * MIB, TTL = 5 * 60_000;
type ScopeOptions = {
  readonly identity: ImageScopeIdentity;
  readonly read: (id: string, signal: AbortSignal, onProgress?: () => void) => Promise<Blob>;
  readonly canRead: () => boolean;
  readonly canDownload: () => boolean;
};
type Waiter = { readonly priority: ImageReadPriority; readonly signal: AbortSignal; readonly resolve: (lease: VerifiedImageLease) => void; readonly reject: (error: unknown) => void; finish(): void };
type LeaseRecord = { readonly priority: ImageReadPriority; readonly lease: VerifiedImageLease; invalidate(): void };
type Entry = {
  readonly asset: SavedAsset; readonly controller: AbortController; readonly waiters: Set<Waiter>; readonly leases: Set<LeaseRecord>; readonly decodeJobs: Set<Promise<unknown>>;
  priority: ImageReadPriority; frameCount: number | null; singleFrame: boolean; canvas: ImageSize | null; bytes: number; admitted: boolean; reading: boolean; blob: Blob | null; pending: Promise<void> | null; touched: number; expiry: ReturnType<typeof setTimeout> | null;
};

function scopeKey(identity: ImageScopeIdentity): string {
  const origin = new URL(identity.serverOrigin);
  if (origin.origin !== identity.serverOrigin || origin.username || origin.password || !identity.actorUserId || !/^[1-9][0-9]*$/.test(identity.authorizationGeneration)) throw new Error('Invalid image scope.');
  const owner = identity.owner;
  if (owner.kind === 'record' && (!owner.recordId || !owner.namespace || !owner.revision)) throw new Error('Invalid image record scope.');
  return JSON.stringify([identity.serverOrigin, identity.actorUserId, identity.authorizationGeneration, owner.kind, ...(owner.kind === 'session' ? [sessionFenceKey(owner.fence), owner.nativeSessionId] : [owner.namespace, owner.recordId, owner.revision])]);
}
function signature(resource: SessionResource): string {
  return JSON.stringify([resource.resourceId, resource.name, resource.mediaType, resource.byteLength, resource.sha256, resource.width ?? null, resource.height ?? null, resource.frameCount ?? null]);
}

class SavedScope implements ImageScope {
  readonly identity: ImageScopeIdentity;
  readonly key: string;
  readonly lifetime = new AbortController();
  readonly assets = new Map<string, SavedAsset>();
  private readonly signatures = new Map<string, string>();
  private assetSerial = 0;
  private listeners = new Set<() => void>();
  constructor(readonly store: SessionImageStore, readonly options: ScopeOptions, serial: number) {
    this.identity = structuredClone(options.identity);
    Object.freeze(this.identity.owner); Object.freeze(this.identity);
    this.key = `${scopeKey(this.identity)}/${serial}`;
  }
  get valid() { return !this.lifetime.signal.aborted; }
  canRead = () => this.valid && this.options.canRead();
  canDownload = () => this.canRead() && this.options.canDownload();
  subscribeInvalidation = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  asset(resource: SessionResource): ImageAssetAdapter | null {
    if (!this.valid || resource.status !== 'available' || !isDisplayMime(resource.mediaType) || !resource.byteLength || !/^[1-9][0-9]*$/.test(resource.byteLength) || Number(resource.byteLength) > MAX_IMAGE || !resource.sha256 || !/^[a-f0-9]{64}$/.test(resource.sha256)) return null;
    const previous = this.assets.get(resource.resourceId);
    const incoming = signature(resource), canonical = this.signatures.get(resource.resourceId);
    if (canonical !== undefined && canonical !== incoming) { previous?.invalidate(); throw new ImageFailure('resource_changed', 'The saved image description changed. Reload this history.'); }
    if (previous && !previous.lifetime.signal.aborted) return previous;
    this.signatures.set(resource.resourceId, incoming);
    const asset = new SavedAsset(this, Object.freeze({ ...resource }), ++this.assetSerial);
    this.assets.set(resource.resourceId, asset); return asset;
  }
  retainResources(resourceIds: ReadonlySet<string>): void {
    for (const [id, asset] of this.assets) {
      if (resourceIds.has(id)) continue;
      this.assets.delete(id); asset.invalidate();
    }
  }
  invalidate(): Promise<void> {
    if (this.valid) {
      this.lifetime.abort(new ImageFailure('access_revoked', 'Image access has ended.'));
      for (const asset of this.assets.values()) asset.invalidate();
      for (const listener of this.listeners) listener(); this.listeners.clear();
    }
    return this.store.drainScope(this);
  }
}
class SavedAsset implements ImageAssetAdapter {
  readonly key: string;
  readonly signature: string;
  readonly lifetime = new AbortController();
  private listeners = new Set<() => void>();
  constructor(readonly scope: SavedScope, readonly resource: SessionResource, incarnation: number) {
    this.signature = signature(resource);
    this.key = JSON.stringify([scope.key, Object.hasOwn(resource, 'revision') ? 'saved' : 'legacy', resource.resourceId, resource.revision ?? null, resource.sha256, incarnation]);
  }
  canRead = () => !this.lifetime.signal.aborted && this.scope.canRead();
  canDownload = () => this.canRead() && this.scope.canDownload();
  acquire = (signal: AbortSignal, priority: ImageReadPriority = 'background') => this.scope.store.acquire(this, signal, priority);
  subscribeInvalidation = (listener: () => void) => {
    if (this.lifetime.signal.aborted) { listener(); return () => {}; }
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  invalidate() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new ImageFailure('access_revoked', 'Image access has ended.'));
    this.scope.store.invalidateAsset(this);
    for (const listener of this.listeners) listener(); this.listeners.clear();
  }
}

/** Page-owned originals and reservations. It never creates a Session client or persists image bytes. */
export class SessionImageStore {
  private serial = 0;
  private scopes = new Set<SavedScope>();
  private entries = new Map<string, Entry>();
  private decoders = new ImageDecodePool();
  createScope(options: ScopeOptions): ImageScope { const scope = new SavedScope(this, options, ++this.serial); this.scopes.add(scope); return scope; }
  private assertAsset(asset: SavedAsset) {
    if (!(asset instanceof SavedAsset) || asset.scope.store !== this || !asset.scope.valid || asset.lifetime.signal.aborted) throw new ImageFailure('access_revoked', 'Image access has ended.');
    if (!asset.canRead()) throw new ImageFailure('access_pending', 'Image access is being checked.');
  }
  acquire(asset: SavedAsset, signal: AbortSignal, priority: ImageReadPriority): Promise<VerifiedImageLease> {
    try { signal.throwIfAborted(); this.assertAsset(asset); } catch (error) { return Promise.reject(error); }
    let entry = this.entries.get(asset.key);
    if (entry?.controller.signal.aborted) return Promise.reject(entry.controller.signal.reason);
    if (!entry) {
      entry = { asset, controller: new AbortController(), waiters: new Set(), leases: new Set(), decodeJobs: new Set(), priority, frameCount: null, singleFrame: false, canvas: null, bytes: 0, admitted: false, reading: false, blob: null, pending: null, touched: Date.now(), expiry: null };
      this.entries.set(asset.key, entry);
    }
    if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
    entry.touched = Date.now();
    if (entry.blob) return Promise.resolve(this.lease(entry, priority, signal));
    if (priority !== 'background' && !entry.admitted) entry.priority = priority;
    if (priority === 'background' && !entry.admitted && [...this.entries.values()].filter(item => !item.admitted && item.priority === 'background').length > 32) { this.entries.delete(asset.key); return Promise.reject(new ImageFailure('cache_busy', 'Image loading is busy. Try opening the image.')); }
    const owned = entry, combined = AbortSignal.any([signal, asset.scope.lifetime.signal, asset.lifetime.signal, entry.controller.signal]);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { priority, signal: combined, resolve, reject, finish: () => {
        combined.removeEventListener('abort', aborted); owned.waiters.delete(waiter);
      } };
      const aborted = () => { waiter.finish(); reject(combined.reason); this.unused(owned); };
      combined.addEventListener('abort', aborted, { once: true }); owned.waiters.add(waiter);
      this.pump();
    });
  }
  private admitted() { return [...this.entries.values()].filter(entry => entry.admitted); }
  private fits(entry: Entry, bytes: number, priority = entry.priority): boolean {
    const others = this.admitted().filter(item => item !== entry), own = others.filter(item => item.asset.scope === entry.asset.scope);
    const sum = (items: Entry[]) => items.reduce((total, item) => total + item.bytes, 0);
    if (others.length >= 32 || own.length >= 16 || sum(others) + bytes > 128 * MIB || sum(own) + bytes > 64 * MIB) return false;
    if (priority === 'background') {
      const background = others.filter(item => item.priority === 'background'), ownerBackground = own.filter(item => item.priority === 'background');
      return background.length < 30 && ownerBackground.length < 14 && sum(background) + bytes <= 88 * MIB && sum(ownerBackground) + bytes <= 24 * MIB;
    }
    const foreground = others.filter(item => item.priority !== 'background');
    return foreground.length < 2 && sum(foreground) + bytes <= 40 * MIB && !foreground.some(item => item.priority === priority);
  }
  private pump() {
    for (const entry of [...this.entries.values()].filter(item => !item.admitted).sort((a, b) => Number(a.priority === 'background') - Number(b.priority === 'background'))) {
      if (!entry.waiters.size) { this.remove(entry); continue; }
      const reservation = Number(entry.asset.resource.byteLength) * 2;
      if (!this.fits(entry, reservation)) {
        for (const old of this.admitted().filter(item => !item.waiters.size && !item.leases.size && !item.reading && !item.decodeJobs.size).sort((a, b) => a.touched - b.touched)) {
          this.remove(old); if (this.fits(entry, reservation)) break;
        }
      }
      if (!this.fits(entry, reservation)) continue;
      entry.admitted = true; entry.bytes = reservation; entry.reading = true;
      entry.pending = this.read(entry);
    }
  }
  private async read(entry: Entry): Promise<void> {
    const { asset } = entry;
    let progressTimer: ReturnType<typeof setTimeout>;
    const timeout = () => entry.controller.abort(new ImageFailure('read_timeout', 'Image reading timed out. Try again.'));
    const progress = () => { clearTimeout(progressTimer); progressTimer = setTimeout(timeout, 15_000); };
    const totalTimer = setTimeout(timeout, 60_000); progress();
    const signal = AbortSignal.any([entry.controller.signal, asset.scope.lifetime.signal, asset.lifetime.signal]);
    try {
      this.assertAsset(asset);
      const original = await asset.scope.options.read(asset.resource.resourceId, signal, progress);
      signal.throwIfAborted(); this.assertAsset(asset);
      if (original.size !== Number(asset.resource.byteLength)) throw new ImageFailure('integrity_failed', 'The saved image failed integrity verification.');
      const bytes = await original.arrayBuffer(); signal.throwIfAborted();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      signal.throwIfAborted(); this.assertAsset(asset);
      if (String(bytes.byteLength) !== asset.resource.byteLength || digest !== asset.resource.sha256) throw new ImageFailure('integrity_failed', 'The saved image failed integrity verification.');
      const container = verifyImageContainer(new Uint8Array(bytes), asset.resource.mediaType as VerifiedImageLease['mediaType']);
      if (container.frameCount !== null && asset.resource.frameCount != null && container.frameCount !== asset.resource.frameCount) throw new ImageFailure('integrity_failed', 'The saved image frame count does not match its description.');
      entry.frameCount = container.frameCount ?? asset.resource.frameCount ?? null;
      entry.singleFrame = container.frameCount === 1;
      entry.canvas = container.canvas;
      signal.throwIfAborted(); this.assertAsset(asset);
      entry.blob = original.slice(0, original.size, asset.resource.mediaType!);
      entry.bytes = original.size;
      for (const waiter of [...entry.waiters]) {
        waiter.finish();
        if (waiter.signal.aborted) waiter.reject(waiter.signal.reason);
        else waiter.resolve(this.lease(entry, waiter.priority, waiter.signal));
      }
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error instanceof ImageFailure ? error : new ImageFailure('read_failed', 'The saved image could not be read. Try again.');
      for (const waiter of [...entry.waiters]) { waiter.finish(); waiter.reject(failure); }
      entry.blob = null;
    } finally {
      clearTimeout(totalTimer); clearTimeout(progressTimer!);
      entry.reading = false; entry.pending = null;
      if (!entry.blob || signal.aborted) this.remove(entry); else this.unused(entry);
      this.pump();
    }
  }
  private lease(entry: Entry, priority: ImageReadPriority, signal: AbortSignal): VerifiedImageLease {
    this.assertAsset(entry.asset); signal.throwIfAborted();
    const asset = entry.asset, descriptor = asset.resource, life = new AbortController();
    const combined = AbortSignal.any([signal, life.signal, asset.lifetime.signal, asset.scope.lifetime.signal]);
    const listeners = new Set<() => void>();
    let valid = true;
    const lease: VerifiedImageLease = {
      blob: entry.blob!, mediaType: descriptor.mediaType as VerifiedImageLease['mediaType'], byteLength: Number(descriptor.byteLength), sha256: descriptor.sha256!,
      storedSize: descriptor.width && descriptor.height ? { width: descriptor.width, height: descriptor.height } : entry.canvas,
      get valid() { return valid && !combined.aborted; },
      decode: (decodeSignal, decodePriority = priority) => {
        if (!lease.valid) return Promise.reject(new ImageFailure('access_revoked', 'Image access has ended.'));
        const pending = this.decoders.acquire(lease.blob, lease.storedSize, AbortSignal.any([combined, decodeSignal]), decodePriority, entry.frameCount, entry.singleFrame);
        entry.decodeJobs.add(pending);
        void pending.finally(() => { entry.decodeJobs.delete(pending); this.unused(entry); this.pump(); }).catch(() => {});
        return pending;
      },
      subscribeInvalidation(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      release: () => {
        if (!valid) return;
        valid = false; combined.removeEventListener('abort', lease.release); life.abort(); entry.leases.delete(record);
        for (const listener of listeners) listener(); listeners.clear(); this.unused(entry); this.pump();
      },
    };
    const record: LeaseRecord = { priority, lease, invalidate: lease.release };
    entry.leases.add(record); combined.addEventListener('abort', lease.release, { once: true });
    return lease;
  }
  private unused(entry: Entry) {
    if (entry.waiters.size) return;
    if (entry.decodeJobs.size) return;
    if (entry.reading) { if (!entry.leases.size) entry.controller.abort(); return; }
    if (!entry.blob || !entry.asset.scope.valid || entry.asset.lifetime.signal.aborted) { this.remove(entry); return; }
    if (entry.priority !== 'background' && ![...entry.leases].some(record => record.priority !== 'background')) {
      if (this.fits(entry, entry.bytes, 'background')) entry.priority = 'background';
      else { this.remove(entry); return; }
    }
    if (entry.leases.size) return;
    entry.touched = Date.now();
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = setTimeout(() => { this.remove(entry); this.pump(); }, TTL);
  }
  private remove(entry: Entry) {
    if (entry.reading || entry.decodeJobs.size) { entry.controller.abort(); return; }
    if (this.entries.get(entry.asset.key) === entry) this.entries.delete(entry.asset.key);
    if (entry.expiry) clearTimeout(entry.expiry); entry.expiry = null;
    entry.blob = null; entry.bytes = 0; entry.admitted = false;
    for (const record of [...entry.leases]) record.invalidate();
  }
  invalidateAsset(asset: SavedAsset) {
    const entry = this.entries.get(asset.key);
    if (entry) { for (const record of [...entry.leases]) record.invalidate(); this.remove(entry); }
    this.pump();
  }
  async drainScope(scope: SavedScope): Promise<void> {
    await Promise.all([...this.entries.values()].filter(entry => entry.asset.scope === scope).flatMap(entry => [entry.pending, ...entry.decodeJobs].map(pending => Promise.resolve(pending).catch(() => {}))));
    this.scopes.delete(scope);
  }
  usage() {
    const entries = this.admitted();
    return { bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), items: entries.length, queued: [...this.entries.values()].filter(entry => !entry.admitted).length, decoded: this.decoders.usage() };
  }
  async close() { await Promise.all([...this.scopes].map(scope => scope.invalidate())); }
}

export const pageImageStore = new SessionImageStore();
