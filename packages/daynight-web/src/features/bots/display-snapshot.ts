import {
  botDisplayHistoryKey, parseBotDisplayPreview, prepareBotDisplayPreview,
  MAX_SNAPSHOTS, MAX_TOTAL_UNITS, type BotDisplayPreview,
} from './display-snapshot-codec';

export * from './display-snapshot-codec';

export const BOT_DISPLAY_SNAPSHOT_NAMESPACE = 'daynight:bot-display:v1:';
const initialGeneration = '00000000-0000-0000-0000-000000000000';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const keyFor = (ownerUserId: string): string => BOT_DISPLAY_SNAPSHOT_NAMESPACE + ownerUserId;

type RecordValue = { historyVersion: string; preview: BotDisplayPreview };
/** Array order is least to most recently read or saved; wall-clock changes cannot reorder it. */
type Envelope = { schemaVersion: 1; ownerUserId: string; generation: string; records: RecordValue[] };
type Account = { value: Envelope; memoryOnly: boolean; localGeneration: object; clearing: number; revokedAll: boolean; revokedTargets: Set<string> };
type Realm = { accounts: Map<string, Account>; listeners: Set<(ownerUserId: string) => void>; tail: Promise<void> };
const realms = new WeakMap<object, Realm>();
const unavailableStorage = {};
function realmFor(storage: Storage | null): Realm {
  const key = storage ?? unavailableStorage;
  let realm = realms.get(key);
  if (!realm) { realm = { accounts: new Map(), listeners: new Set(), tail: Promise.resolve() }; realms.set(key, realm); }
  return realm;
}
const emptyEnvelope = (ownerUserId: string, generation = initialGeneration): Envelope => ({ schemaVersion: 1, ownerUserId, generation, records: [] });
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid display snapshot envelope.');
  return value as Record<string, unknown>;
}
function parseEnvelope(raw: string, ownerUserId: string): Envelope {
  if (raw.length > MAX_TOTAL_UNITS) throw new Error('Display snapshot storage limit exceeded.');
  const data = exact(JSON.parse(raw), ['schemaVersion', 'ownerUserId', 'generation', 'records']);
  if (data.schemaVersion !== 1 || data.ownerUserId !== ownerUserId || !uuid(data.generation) || !Array.isArray(data.records) || data.records.length > MAX_SNAPSHOTS) throw new Error('Invalid display snapshot account.');
  const ids = new Set<string>();
  const records = data.records.map(value => {
    const row = exact(value, ['historyVersion', 'preview']);
    const botId: unknown = row.preview && typeof row.preview === 'object' && 'botId' in row.preview ? row.preview.botId : null;
    if (!uuid(botId) || !uuid(row.historyVersion) || ids.has(botId)) throw new Error('Invalid display snapshot record.');
    ids.add(botId);
    return { historyVersion: row.historyVersion, preview: parseBotDisplayPreview(row.preview, ownerUserId, botId) };
  });
  return { schemaVersion: 1, ownerUserId, generation: data.generation, records };
}

/** Injected locks must serialize this name across every writer sharing the storage. */
export type BotDisplaySnapshotLock = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
export type BotDisplaySnapshotStoreOptions = {
  /** The caller owns account confirmation, authentication pauses and deletion barriers. */
  readonly isCurrent: (ownerUserId: string) => boolean;
  readonly storage?: Storage | null;
  readonly withLock?: BotDisplaySnapshotLock;
};
/** Opaque store-owned lease. Capture before scheduling work; never refresh a stale queued write. */
export type BotDisplaySnapshotObservation = {
  readonly ownerUserId: string;
  readonly botId: string;
  readonly generation: string;
  readonly historyVersion: string | null;
};
type Lease = { ownerUserId: string; botId: string; generation: string; localGeneration: object; historyVersion: string | null; historyKey: string | null };
export type BotDisplaySnapshotSave = {
  readonly source: 'verified-history';
  /** True only for protocol-accepted history of this exact identity, including authoritative empty history. */
  readonly historyLoaded: true;
  readonly preview: BotDisplayPreview;
};
export type BotDisplaySnapshotSaveResult = 'saved' | 'memory' | 'stale' | 'invalid' | 'unavailable';

function browserStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
function browserLock(): BotDisplaySnapshotLock | undefined {
  try {
    const locks = navigator.locks;
    if (locks) return (name, run) => locks.request(name, () => run());
  } catch { /* Without origin-wide serialization, only memory writes are safe. */ }
  return undefined;
}

/**
 * Account-scoped display data, never a source of authentication or live client state.
 * All operations serialize per origin/account. Browsers without Web Locks and failed
 * storage operations degrade to page memory; no unlocked read-modify-write reaches disk.
 * Scheduling/throttling and pagehide flushing belong to the real-history observer.
 */
export class BotDisplaySnapshotStore {
  private readonly storage: Storage | null;
  private readonly lock: BotDisplaySnapshotLock | undefined;
  private readonly realm: Realm;
  private readonly leases = new WeakMap<BotDisplaySnapshotObservation, Lease>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private revision = 0;
  constructor(private readonly options: BotDisplaySnapshotStoreOptions) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.lock = options.withLock ?? browserLock();
    this.realm = realmFor(this.storage);
    this.realm.listeners.add(this.changed);
    if (typeof window !== 'undefined') window.addEventListener('storage', this.storageChanged);
  }
  private current(ownerUserId: string): boolean { return !this.closed && uuid(ownerUserId) && this.options.isCurrent(ownerUserId); }
  private changed = (_ownerUserId: string): void => {
    if (this.closed) return;
    this.revision++;
    for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot interrupt invalidation or persistence. */ } }
  };
  private publish(ownerUserId: string): void { for (const listener of this.realm.listeners) listener(ownerUserId); }
  /** Change notifications cover this page and storage events; re-read under the current account guard. */
  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  getVersion = (): number => this.revision;
  private account(ownerUserId: string): Account {
    let account = this.realm.accounts.get(ownerUserId);
    if (!account) {
      account = { value: emptyEnvelope(ownerUserId), memoryOnly: !this.storage || !this.lock, localGeneration: {}, clearing: 0, revokedAll: false, revokedTargets: new Set() };
      this.realm.accounts.set(ownerUserId, account);
      // Read-only recovery is useful even if this browser cannot safely persist new writes.
      if (this.storage) {
        try { const raw = this.storage.getItem(keyFor(ownerUserId)); if (raw !== null) account.value = parseEnvelope(raw, ownerUserId); }
        catch { account.memoryOnly = true; account.value = emptyEnvelope(ownerUserId, crypto.randomUUID()); }
      }
    }
    return account;
  }
  private refresh(ownerUserId: string): Account {
    const account = this.account(ownerUserId);
    if (account.memoryOnly || !this.storage) return account;
    try {
      const raw = this.storage.getItem(keyFor(ownerUserId));
      const value = raw === null ? emptyEnvelope(ownerUserId) : parseEnvelope(raw, ownerUserId);
      if (value.generation !== account.value.generation) account.localGeneration = {};
      account.value = this.withRevocations(account, value);
    } catch {
      // A corrupt or denied read is a miss, never an invitation to overwrite another tab.
      account.value = emptyEnvelope(ownerUserId, crypto.randomUUID());
      account.localGeneration = {}; account.memoryOnly = true;
    }
    return account;
  }
  private revoke(account: Account, botId?: string): void {
    if (botId === undefined) account.revokedAll = true;
    else account.revokedTargets.add(botId);
  }
  private withRevocations(account: Account, value: Envelope): Envelope {
    return { ...value, records: value.records.filter(row => !account.revokedAll && !account.revokedTargets.has(row.preview.botId)) };
  }
  private persist(account: Account): boolean {
    if (account.memoryOnly || !this.storage) return false;
    try {
      this.storage.setItem(keyFor(account.value.ownerUserId), JSON.stringify(account.value));
      account.revokedAll = false; account.revokedTargets.clear();
      return true;
    }
    catch { account.memoryOnly = true; return false; }
  }
  private serialized<T>(ownerUserId: string, run: (locked: boolean) => T, fallback: T): Promise<T> {
    const execute = async (): Promise<T> => {
      if (this.lock) {
        let entered = false;
        try { return await this.lock(keyFor(ownerUserId), () => { entered = true; return run(true); }); }
        catch {
          // Never repeat a callback whose completion is unknown.
          if (entered) return fallback;
          this.account(ownerUserId).memoryOnly = true;
        }
      }
      this.account(ownerUserId).memoryOnly = true;
      return run(false);
    };
    const result = this.realm.tail.then(execute);
    this.realm.tail = result.then(() => {}, () => {});
    return result;
  }
  private storageChanged = (event: StorageEvent): void => {
    if (this.closed || event.storageArea !== this.storage) return;
    const owners = event.key === null ? [...this.realm.accounts.keys()] : event.key.startsWith(BOT_DISPLAY_SNAPSHOT_NAMESPACE) ? [event.key.slice(BOT_DISPLAY_SNAPSHOT_NAMESPACE.length)] : [];
    for (const owner of owners) {
      const account = this.realm.accounts.get(owner);
      if (!uuid(owner) || !account) continue;
      // Event values may already be superseded. Re-read storage inside the lock;
      // a removal event still fences leases immediately, including an ABA clear/rewrite.
      if (event.newValue === null) {
        account.localGeneration = {};
        account.value = emptyEnvelope(owner, crypto.randomUUID());
      } else {
        try {
          const incoming = parseEnvelope(event.newValue, owner);
          if (incoming.generation !== account.value.generation) {
            account.localGeneration = {};
            if (account.memoryOnly) account.value = emptyEnvelope(owner, incoming.generation);
          }
        } catch { account.localGeneration = {}; account.value = emptyEnvelope(owner, crypto.randomUUID()); account.memoryOnly = true; }
      }
      this.publish(owner);
    }
  };
  /** Returns a detached preview after account confirmation; reading updates the bounded LRU. */
  read(ownerUserId: string, botId: string): Promise<BotDisplayPreview | null> {
    if (!this.current(ownerUserId) || !uuid(botId)) return Promise.resolve(null);
    return this.serialized(ownerUserId, () => {
      if (!this.current(ownerUserId)) return null;
      const account = this.refresh(ownerUserId);
      if (account.clearing) return null;
      const index = account.value.records.findIndex(row => row.preview.botId === botId);
      if (index < 0) return null;
      const row = account.value.records[index]!;
      account.value.records.splice(index, 1); account.value.records.push(row);
      this.persist(account);
      return parseBotDisplayPreview(row.preview, ownerUserId, botId);
    }, null);
  }
  /**
   * Capture when admitting verified history, before timers or asynchronous history work.
   * Account-wide generation changes (including eviction/target clearing) expire leases.
   * Renew only after checking the current authoritative history identity and authorization;
   * never renew merely to retry the payload of a rejected queued write.
   */
  observe(ownerUserId: string, botId: string): Promise<BotDisplaySnapshotObservation | null> {
    if (!this.current(ownerUserId) || !uuid(botId)) return Promise.resolve(null);
    return this.serialized(ownerUserId, () => {
      if (!this.current(ownerUserId)) return null;
      const account = this.refresh(ownerUserId);
      if (account.clearing) return null;
      const row = account.value.records.find(row => row.preview.botId === botId);
      const observation = Object.freeze({ ownerUserId, botId, generation: account.value.generation, historyVersion: row?.historyVersion ?? null });
      this.leases.set(observation, { ...observation, localGeneration: account.localGeneration, historyKey: null });
      return observation;
    }, null);
  }
  /** Invalid input and stale leases leave the last readable snapshot untouched. */
  save(observation: BotDisplaySnapshotObservation, input: BotDisplaySnapshotSave): Promise<BotDisplaySnapshotSaveResult> {
    const lease = this.leases.get(observation);
    if (!lease || !this.current(lease.ownerUserId)) return Promise.resolve('unavailable');
    if (!input || input.source !== 'verified-history' || input.historyLoaded !== true || Object.keys(input).some(key => !['source', 'historyLoaded', 'preview'].includes(key))) return Promise.resolve('invalid');
    let preview: BotDisplayPreview | null;
    try { preview = prepareBotDisplayPreview(input.preview, lease.ownerUserId, lease.botId); } catch { return Promise.resolve('invalid'); }
    if (!preview) return Promise.resolve('invalid');
    // The parser creates a detached value before yielding, so callers cannot mutate a queued write.
    const candidate = preview;
    return this.serialized<BotDisplaySnapshotSaveResult>(lease.ownerUserId, () => {
      if (!this.current(lease.ownerUserId)) return 'unavailable';
      const account = this.refresh(lease.ownerUserId);
      if (account.clearing || lease.localGeneration !== account.localGeneration || lease.generation !== account.value.generation) return 'stale';
      const previous = account.value.records.find(row => row.preview.botId === lease.botId);
      const historyKey = botDisplayHistoryKey(candidate), sameHistory = previous && botDisplayHistoryKey(previous.preview) === historyKey;
      if (lease.historyKey !== null && lease.historyKey !== historyKey) return 'stale';
      if (lease.historyVersion !== (previous?.historyVersion ?? null)) return 'stale';
      if (sameHistory) {
        if (BigInt(candidate.lastEventSeq) < BigInt(previous.preview.lastEventSeq)) return 'stale';
        const revisions = new Map(previous.preview.entries.map(entry => [entry.entryId, entry.revision]));
        if (candidate.entries.some(entry => revisions.has(entry.entryId) && BigInt(entry.revision) < BigInt(revisions.get(entry.entryId)!))) return 'stale';
      }
      const historyVersion = sameHistory ? previous.historyVersion : crypto.randomUUID();
      const records = account.value.records.filter(row => row.preview.botId !== lease.botId);
      records.push({ historyVersion, preview: candidate });
      const next: Envelope = { ...account.value, records };
      let evicted = false;
      while (next.records.length > MAX_SNAPSHOTS || JSON.stringify(next).length > MAX_TOTAL_UNITS) {
        if (next.records.length === 1) return 'invalid';
        next.records.shift(); evicted = true;
      }
      // Eviction also fences writers that observed absence before an insert/evict cycle.
      if (evicted) { next.generation = crypto.randomUUID(); account.localGeneration = {}; }
      account.value = next;
      lease.generation = next.generation; lease.localGeneration = account.localGeneration;
      lease.historyVersion = historyVersion; lease.historyKey = historyKey;
      const persisted = this.persist(account);
      this.publish(lease.ownerUserId);
      return persisted ? 'saved' : 'memory';
    }, 'unavailable');
  }
  /**
   * Remove this target, normally preserving other persisted snapshots but expiring all account leases.
   * Revocation is synchronous; the result reports best-effort durable clearing. If disk cannot
   * be read, clear the account envelope rather than republish unverified sibling snapshots.
   */
  clearTarget(ownerUserId: string, botId: string): Promise<boolean> { return this.clear(ownerUserId, botId); }
  clearAccount(ownerUserId: string): Promise<boolean> { return this.clear(ownerUserId); }
  private clear(ownerUserId: string, botId?: string): Promise<boolean> {
    if (this.closed || !uuid(ownerUserId) || botId !== undefined && !uuid(botId)) return Promise.resolve(false);
    const account = this.account(ownerUserId);
    account.clearing++;
    this.revoke(account, botId);
    const generation = crypto.randomUUID();
    account.localGeneration = {};
    account.value = { ...account.value, generation, records: account.value.records.filter(row => botId !== undefined && row.preview.botId !== botId) };
    // Prevent reads and newly created stores from recovering disk data while clear waits for its lock.
    account.memoryOnly = true;
    this.publish(ownerUserId);
    return this.serialized(ownerUserId, locked => {
      // Earlier successful clears may have flushed the shared markers while this
      // clear waited. Reapply its own marker and retain every failed revocation.
      this.revoke(account, botId);
      if (locked && this.storage) {
        try {
          const raw = this.storage.getItem(keyFor(ownerUserId));
          const disk = raw === null ? emptyEnvelope(ownerUserId) : parseEnvelope(raw, ownerUserId);
          account.value = this.withRevocations(account, { ...disk, generation });
        } catch {
          // Unreadable disk may contain a newer cross-tab revocation. Never republish
          // unverified sibling snapshots from page memory into that namespace.
          account.value = emptyEnvelope(ownerUserId, generation);
        }
      }
      // Every queued clear reapplies its own target filter after prior clears or disk refreshes.
      // A prior quota/read failure must not suppress a later, smaller revocation tombstone.
      account.value = this.withRevocations(account, { ...account.value, generation });
      account.memoryOnly = !locked || !this.storage;
      const persisted = this.persist(account);
      account.clearing--;
      this.publish(ownerUserId); return persisted;
    }, false);
  }
  /** Release subscriptions and invalidate this store's leases without deleting successful snapshots. */
  close(): void {
    if (this.closed) return;
    this.closed = true; this.listeners.clear(); this.realm.listeners.delete(this.changed);
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.storageChanged);
  }
}
