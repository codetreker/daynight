import { sessionFenceKey, type SessionResource } from '../../../../../daynight/src/session/protocol';
import { ImageDecodePool } from './image-decode';
import { verifyImageContainer } from './image-format';
import { ImageFailure, isDisplayMime, type ImageAssetAdapter, type ImageReadPriority, type ImageScope, type ImageScopeIdentity, type ImageSize, type LocalImageAssetAdapter, type LocalImageMetadata, type VerifiedImageLease } from './image-types';
export * from './image-types';

const MIB = 1_048_576, MAX_IMAGE = 10 * MIB, TTL = 5 * 60_000;
const localMimes = ['image/png', 'image/jpeg', 'image/webp'] as const;
type LocalAssetOptions = { readonly key: string; readonly blob: Blob; readonly metadata?: LocalImageMetadata };
type OriginalMetadata = Pick<VerifiedImageLease, 'mediaType' | 'byteLength' | 'sha256' | 'storedSize'>;
type ScopeOptions = {
  readonly identity: ImageScopeIdentity;
  readonly read: (id: string, signal: AbortSignal, onProgress?: () => void) => Promise<Blob>;
  readonly canRead: () => boolean;
  readonly canDownload: () => boolean;
};
type Waiter = { readonly priority: ImageReadPriority; readonly signal: AbortSignal; readonly resolve: (lease: VerifiedImageLease) => void; readonly reject: (error: unknown) => void; finish(): void };
type LeaseRecord = { readonly priority: ImageReadPriority; readonly lease: VerifiedImageLease; invalidate(): void };
type Entry = {
  readonly asset: StoredAsset; readonly controller: AbortController; readonly waiters: Set<Waiter>; readonly leases: Set<LeaseRecord>; readonly decodeJobs: Set<Promise<unknown>>;
  validation: { readonly priority: ImageReadPriority; readonly controller: AbortController } | null;
  priority: ImageReadPriority; frameCount: number | null; singleFrame: boolean; metadata: OriginalMetadata | null; bytes: number; admitted: boolean; reading: boolean; blob: Blob | null; pending: Promise<void> | null; touched: number; expiry: ReturnType<typeof setTimeout> | null;
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
function sameLocalMetadata(a: LocalImageMetadata, b: LocalImageMetadata | null | undefined): boolean {
  return b !== null && b !== undefined && a.mediaType === b.mediaType && a.byteLength === b.byteLength && a.sha256 === b.sha256 && a.width === b.width && a.height === b.height && a.frameCount === b.frameCount;
}

class SavedScope implements ImageScope {
  readonly identity: ImageScopeIdentity;
  readonly key: string;
  readonly lifetime = new AbortController();
  readonly assets = new Map<string, SavedAsset>();
  readonly localAssets = new Map<string, LocalAsset>();
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
  localAsset(options: LocalAssetOptions): LocalImageAssetAdapter {
    const previous = this.localAssets.get(options.key);
    if (previous && !previous.lifetime.signal.aborted) {
      if (previous.original !== options.blob) throw new ImageFailure('resource_changed', 'The local image byte version changed. Select the image again.');
      if (options.metadata && !sameLocalMetadata(options.metadata, previous.expected) && !sameLocalMetadata(options.metadata, previous.metadata)) throw new ImageFailure('integrity_failed', 'The local image description changed.');
      return previous;
    }
    const asset = new LocalAsset(this, options, ++this.assetSerial);
    this.localAssets.set(options.key, asset); return asset;
  }
  invalidate(): Promise<void> {
    if (this.valid) {
      this.lifetime.abort(new ImageFailure('access_revoked', 'Image access has ended.'));
      for (const asset of this.assets.values()) asset.invalidate();
      for (const asset of this.localAssets.values()) asset.release();
      for (const listener of this.listeners) listener(); this.listeners.clear();
    }
    return this.store.drainScope(this);
  }
}
abstract class StoredAsset implements ImageAssetAdapter {
  abstract readonly key: string;
  abstract readonly resource: SessionResource | null;
  abstract readonly byteLength: number;
  readonly lifetime = new AbortController();
  private listeners = new Set<() => void>();
  constructor(readonly scope: SavedScope) {}
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
class SavedAsset extends StoredAsset {
  readonly key: string;
  readonly signature: string;
  readonly byteLength: number;
  constructor(scope: SavedScope, readonly resource: SessionResource, incarnation: number) {
    super(scope); this.signature = signature(resource); this.byteLength = Number(resource.byteLength);
    this.key = JSON.stringify([scope.key, Object.hasOwn(resource, 'revision') ? 'saved' : 'legacy', resource.resourceId, resource.revision ?? null, resource.sha256, incarnation]);
  }
}
class LocalAsset extends StoredAsset implements LocalImageAssetAdapter {
  readonly resource = null;
  readonly key: string;
  readonly byteLength: number;
  readonly expected: LocalImageMetadata | undefined;
  readonly localKey: string;
  original: Blob | null;
  verified: LocalImageMetadata | null = null;
  constructor(scope: SavedScope, options: LocalAssetOptions, incarnation: number) {
    super(scope); this.original = options.blob; this.byteLength = options.blob.size;
    this.localKey = options.key;
    this.expected = options.metadata ? Object.freeze({ ...options.metadata }) : undefined;
    this.key = JSON.stringify([scope.key, 'draft', options.key, incarnation]);
  }
  get metadata() { return this.lifetime.signal.aborted ? null : this.verified; }
  async validate(signal: AbortSignal): Promise<LocalImageMetadata> {
    // User-selected originals need the same foreground reservation as opening
    // them: two valid 10 MiB drafts cannot verify inside the 24 MiB background
    // allowance while the first frame keeps its original. Release immediately
    // after validation so the existing preview reservation remains shared.
    const lease = await this.acquire(signal, 'preview');
    try {
      signal.throwIfAborted();
      if (!lease.valid || !this.metadata) throw new ImageFailure('access_revoked', 'Image access has ended.');
      return this.metadata;
    }
    finally { lease.release(); }
  }
  release = () => {
    if (this.scope.localAssets.get(this.localKey) === this) this.scope.localAssets.delete(this.localKey);
    this.original = null; this.verified = null; this.invalidate();
  };
}

/** Page-owned originals and reservations. It never creates a Session client or persists image bytes. */
export class SessionImageStore {
  private serial = 0;
  private scopes = new Set<SavedScope>();
  private entries = new Map<string, Entry>();
  private decoders = new ImageDecodePool();
  private localInspection: Promise<void> = Promise.resolve();
  createScope(options: ScopeOptions): ImageScope { const scope = new SavedScope(this, options, ++this.serial); this.scopes.add(scope); return scope; }
  /** Registers immutable draft bytes in the existing authenticated Session owner. */
  createLocalAsset(scope: ImageScope, options: LocalAssetOptions): LocalImageAssetAdapter {
    if (!(scope instanceof SavedScope) || scope.store !== this || !scope.valid || scope.identity.owner.kind !== 'session') throw new ImageFailure('access_revoked', 'Image access has ended.');
    if (!scope.canRead()) throw new ImageFailure('access_pending', 'Image access is being checked.');
    if (!options.key || !Number.isSafeInteger(options.blob.size) || options.blob.size < 1 || options.blob.size > MAX_IMAGE) throw new ImageFailure('integrity_failed', 'Choose an image between 1 byte and 10 MiB.');
    if (options.blob.type && !localMimes.includes(options.blob.type as LocalImageMetadata['mediaType'])) throw new ImageFailure('unsupported_format', 'Choose a PNG, JPEG or WebP image.');
    return scope.localAsset(options);
  }
  private assertAsset(asset: StoredAsset) {
    if (!(asset instanceof StoredAsset) || asset.scope.store !== this || !asset.scope.valid || asset.lifetime.signal.aborted) throw new ImageFailure('access_revoked', 'Image access has ended.');
    if (!asset.canRead()) throw new ImageFailure('access_pending', 'Image access is being checked.');
  }
  acquire(asset: StoredAsset, signal: AbortSignal, priority: ImageReadPriority): Promise<VerifiedImageLease> {
    try { signal.throwIfAborted(); this.assertAsset(asset); } catch (error) { return Promise.reject(error); }
    let entry = this.entries.get(asset.key);
    if (entry?.controller.signal.aborted) return this.acquireAfterDrain(entry, signal, priority);
    if (!entry) {
      entry = { asset, controller: new AbortController(), waiters: new Set(), leases: new Set(), decodeJobs: new Set(), validation: null, priority, frameCount: null, singleFrame: false, metadata: null, bytes: 0, admitted: false, reading: false, blob: null, pending: null, touched: Date.now(), expiry: null };
      this.entries.set(asset.key, entry);
    }
    if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
    entry.touched = Date.now();
    if (entry.blob) { const lease = this.lease(entry, priority, signal); this.pump(); return Promise.resolve(lease); }
    if (priority !== 'background' && !entry.admitted) entry.priority = priority;
    if (priority === 'background' && !entry.admitted && [...this.entries.values()].filter(item => !item.admitted && item.priority === 'background').length > 32) { this.entries.delete(asset.key); return Promise.reject(new ImageFailure('cache_busy', 'Image loading is busy. Try opening the image.')); }
    const owned = entry, combined = AbortSignal.any([signal, asset.scope.lifetime.signal, asset.lifetime.signal, entry.controller.signal]);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { priority, signal: combined, resolve, reject, finish: () => {
        combined.removeEventListener('abort', aborted); owned.waiters.delete(waiter);
      } };
      const aborted = () => { waiter.finish(); reject(combined.reason); this.unused(owned); this.pump(); };
      combined.addEventListener('abort', aborted, { once: true }); owned.waiters.add(waiter);
      if (priority !== 'background' && owned.validation?.priority === 'background') owned.validation.controller.abort();
      this.pump();
    });
  }
  private acquireAfterDrain(entry: Entry, signal: AbortSignal, priority: ImageReadPriority): Promise<VerifiedImageLease> {
    const asset = entry.asset, waiting = AbortSignal.any([signal, asset.scope.lifetime.signal, asset.lifetime.signal]);
    // A previous consumer's cancellation cannot fail a new read or release its
    // reservation before the original reader and decoders have actually stopped.
    return new Promise<void>((resolve, reject) => {
      const aborted = () => { waiting.removeEventListener('abort', aborted); reject(waiting.reason); };
      if (waiting.aborted) { aborted(); return; }
      waiting.addEventListener('abort', aborted, { once: true });
      void Promise.allSettled([entry.pending, ...entry.decodeJobs]).then(() => {
        waiting.removeEventListener('abort', aborted);
        if (waiting.aborted) reject(waiting.reason); else resolve();
      });
    }).then(() => {
      this.remove(entry);
      return this.acquire(asset, signal, priority);
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
  private priorities(entry: Entry): Set<ImageReadPriority> {
    return new Set([...entry.waiters].filter(waiter => !waiter.signal.aborted).map(waiter => waiter.priority).concat([...entry.leases].filter(record => record.lease.valid).map(record => record.priority)));
  }
  private reconcileReservations() {
    const admitted = this.admitted();
    for (const entry of admitted) {
      if (entry.priority === 'background') continue;
      const priorities = this.priorities(entry);
      if (priorities.has(entry.priority)) continue;
      const remaining = [...priorities].find(priority => priority !== 'background') ?? (priorities.has('background') ? 'background' : null);
      if (!remaining) continue;
      if (this.fits(entry, entry.bytes, remaining)) { entry.priority = remaining; continue; }
      if (remaining === 'background') continue;
      const occupant = admitted.find(other => other !== entry && other.priority === remaining);
      if (occupant && this.priorities(occupant).has(entry.priority)) {
        // Swapping reservations preserves both byte totals while each original
        // retains a slot required by one of its remaining consumers.
        occupant.priority = entry.priority; entry.priority = remaining;
      } else if (this.fits(entry, entry.bytes, 'background')) entry.priority = 'background';
      // An occupied destination keeps the old reservation until capacity changes.
      // Readers and decoders remain charged even after cancellation.
    }
  }
  private pump() {
    this.reconcileReservations();
    for (const entry of this.entries.values()) {
      if (entry.admitted) continue;
      const priorities = this.priorities(entry);
      if (!priorities.has(entry.priority)) entry.priority = [...priorities].find(priority => priority !== 'background') ?? 'background';
    }
    for (const entry of [...this.entries.values()].filter(item => !item.admitted).sort((a, b) => Number(a.priority === 'background') - Number(b.priority === 'background'))) {
      if (!entry.waiters.size) { this.remove(entry); continue; }
      const reservation = entry.asset.byteLength * 2;
      if (!this.fits(entry, reservation)) {
        for (const old of this.admitted().filter(item => !item.waiters.size && !item.leases.size && !item.reading && !item.decodeJobs.size).sort((a, b) => a.touched - b.touched)) {
          this.remove(old); this.reconcileReservations(); if (this.fits(entry, reservation)) break;
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
      let verified: Awaited<ReturnType<SessionImageStore['inspectOriginal']>>;
      if (asset instanceof LocalAsset) {
        // Draft hashing retains at most one complete input buffer on the page.
        // Its reservation remains charged until an aborted inspection settles.
        const inspection = this.localInspection.then(() => this.inspectOriginal(asset, asset.original!, signal));
        this.localInspection = inspection.then(() => {}, () => {});
        verified = await inspection;
        progress(); signal.throwIfAborted(); this.assertAsset(asset);
        for (;;) {
          const validation: NonNullable<Entry['validation']> = { priority: [...this.priorities(entry)].find(priority => priority !== 'background') ?? 'background', controller: new AbortController() };
          entry.validation = validation;
          try {
            const pixels = await this.decoders.acquire(verified.blob, verified.metadata.storedSize, AbortSignal.any([signal, validation.controller.signal]), validation.priority, verified.frameCount, verified.singleFrame);
            pixels.release(); break;
          } catch (error) {
            signal.throwIfAborted();
            // Foreground consumers can replace a queued background validation.
            // A running browser task must settle before its replacement starts.
            if (!validation.controller.signal.aborted) throw error;
          } finally { entry.validation = null; }
        }
        signal.throwIfAborted(); this.assertAsset(asset);
        asset.verified = verified.localMetadata;
      } else {
        const original = await asset.scope.options.read(asset.resource!.resourceId, signal, progress);
        verified = await this.inspectOriginal(asset, original, signal);
      }
      entry.frameCount = verified.frameCount;
      entry.singleFrame = verified.singleFrame;
      entry.metadata = verified.metadata;
      signal.throwIfAborted(); this.assertAsset(asset);
      entry.blob = verified.blob;
      entry.bytes = verified.metadata.byteLength;
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
  private async inspectOriginal(asset: StoredAsset, original: Blob, signal: AbortSignal) {
    signal.throwIfAborted(); this.assertAsset(asset);
    const descriptor = asset.resource;
    if (original.size !== asset.byteLength) throw new ImageFailure('integrity_failed', 'The image failed integrity verification.');
    const bytes = await original.arrayBuffer(); signal.throwIfAborted();
    if (bytes.byteLength !== asset.byteLength) throw new ImageFailure('integrity_failed', 'The image failed integrity verification.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    signal.throwIfAborted(); this.assertAsset(asset);
    if (descriptor && digest !== descriptor.sha256) throw new ImageFailure('integrity_failed', 'The saved image failed integrity verification.');
    const data = new Uint8Array(bytes);
    const mediaType = descriptor?.mediaType ?? (original.type || (data[0] === 137 ? 'image/png' : data[0] === 255 && data[1] === 216 ? 'image/jpeg' : data[0] === 82 && data[1] === 73 ? 'image/webp' : ''));
    if (!isDisplayMime(mediaType)) throw new ImageFailure('unsupported_format', 'Choose a PNG, JPEG or WebP image.');
    const container = verifyImageContainer(data, mediaType);
    if (container.frameCount !== null && descriptor?.frameCount != null && container.frameCount !== descriptor.frameCount) throw new ImageFailure('integrity_failed', 'The saved image frame count does not match its description.');
    const frameCount = container.frameCount ?? descriptor?.frameCount ?? null;
    let localMetadata: LocalImageMetadata | null = null;
    if (asset instanceof LocalAsset) {
      if (!container.canvas || frameCount === null || !localMimes.includes(mediaType as LocalImageMetadata['mediaType'])) throw new ImageFailure('unsupported_format', 'Choose a PNG, JPEG or WebP image.');
      localMetadata = Object.freeze({ ...container.canvas, mediaType: mediaType as LocalImageMetadata['mediaType'], byteLength: bytes.byteLength, sha256: digest, frameCount });
      const expected = asset.expected;
      if (expected && !sameLocalMetadata(expected, localMetadata)) throw new ImageFailure('integrity_failed', 'The local image failed integrity verification.');
    }
    const metadata: OriginalMetadata = { mediaType, byteLength: bytes.byteLength, sha256: digest, storedSize: descriptor?.width && descriptor.height ? { width: descriptor.width, height: descriptor.height } : container.canvas };
    return { blob: original.slice(0, original.size, mediaType), metadata, localMetadata, frameCount, singleFrame: container.frameCount === 1 };
  }
  private lease(entry: Entry, priority: ImageReadPriority, signal: AbortSignal): VerifiedImageLease {
    this.assertAsset(entry.asset); signal.throwIfAborted();
    const asset = entry.asset, life = new AbortController();
    const combined = AbortSignal.any([signal, life.signal, asset.lifetime.signal, asset.scope.lifetime.signal]);
    const listeners = new Set<() => void>();
    let valid = true;
    const lease: VerifiedImageLease = {
      blob: entry.blob!, ...entry.metadata!,
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
  invalidateAsset(asset: StoredAsset) {
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
