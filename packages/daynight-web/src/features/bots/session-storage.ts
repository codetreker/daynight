const clearedNamespaces = new Map<string, number>();
const writtenAfterClear = new Set<string>();
const knownSessions = new Map<string, Map<string, Set<string>>>();
let revocationVersion = 0;
const namespace = 'daynight:bot-session:';
function remember(identity: string): void {
  try {
    const binding: unknown = JSON.parse(identity);
    if (!Array.isArray(binding) || binding.length !== 4 || !binding.every(value => typeof value === 'string')) return;
    const [owner, bot, session] = binding as [string, string, string, string];
    const bots = knownSessions.get(owner) ?? new Map<string, Set<string>>();
    const sessions = bots.get(bot) ?? new Set<string>(); sessions.add(session); bots.set(bot, sessions); knownSessions.set(owner, bots);
  } catch { /* Invalid storage keys do not identify a Session to clear. */ }
}
function currentVersion(prefix: string): number {
  let version = 0;
  for (const [cleared, revision] of clearedNamespaces) if (prefix.startsWith(cleared)) version = Math.max(version, revision);
  return version;
}
function clearNamespace(prefix: string, storage: Storage | null | undefined): void {
  // Revoke before touching storage: denied enumeration and failed deletes must
  // not allow a later cache instance or an older writer to restore revoked data.
  clearedNamespaces.set(prefix, ++revocationVersion);
  for (const key of writtenAfterClear) if (key.startsWith(prefix)) writtenAfterClear.delete(key);
  try {
    const disk = storage === undefined ? window.sessionStorage : storage;
    if (!disk) return;
    for (let i = disk.length - 1; i >= 0; i--) {
      const key = disk.key(i);
      if (key?.startsWith(prefix)) {
        const end = key.indexOf(']:');
        if (end !== -1) remember(key.slice(namespace.length, end + 1));
        try { disk.removeItem(key); } catch { /* Continue clearing other owned keys. */ }
      }
    }
  } catch { /* The page tombstone protects later instances when storage recovers. */ }
}

/** Clear account or Bot cold state, returning its known Sessions for display cleanup. */
export function clearBotSessionStorage(userId: string, botId?: string, storage?: Storage | null): readonly string[] {
  const prefix = `${namespace}[${JSON.stringify(userId)},${botId === undefined ? '' : `${JSON.stringify(botId)},`}`;
  clearNamespace(prefix, storage);
  const bots = knownSessions.get(userId), sessions = new Set<string>();
  if (bots) {
    for (const [id, values] of bots) if (botId === undefined || id === botId) {
      for (const session of values) sessions.add(session);
      bots.delete(id);
    }
    if (bots.size === 0) knownSessions.delete(userId);
  }
  return [...sessions];
}

/**
 * A Bot's draft and receipt store. Memory wins over disk after every observed
 * read/write. Page revocation fences survive instance replacement and storage
 * failures; only new instances can save new authorized state after revocation.
 * This store never contains timeline entries, DOM, resources or command payloads.
 */
export class BotSessionStorage implements Storage {
  private readonly values = new Map<string, string | null>();
  private readonly prefix: string;
  private readonly version: number;
  private invalidated = false;
  constructor(identity: string, private readonly storage: Storage | null) {
    this.prefix = `${namespace}${identity}:`; this.version = currentVersion(this.prefix); remember(identity);
  }
  private live(): boolean { return !this.invalidated && this.version === currentVersion(this.prefix); }
  private diskAllowed(key: string): boolean { return writtenAfterClear.has(this.prefix + key) || currentVersion(this.prefix) === 0; }
  private keys(): string[] {
    if (!this.live()) return [];
    const keys = new Set<string>();
    try {
      if (this.storage) for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(this.prefix) && this.diskAllowed(key.slice(this.prefix.length))) keys.add(key.slice(this.prefix.length));
      }
    } catch { /* The same memory inventory works when browser storage is denied. */ }
    for (const [key, value] of this.values) { if (value === null) keys.delete(key); else keys.add(key); }
    return [...keys];
  }
  get length(): number { return this.keys().length; }
  key(index: number): string | null { return this.keys()[index] ?? null; }
  getItem(key: string): string | null {
    if (!this.live()) return null;
    if (this.values.has(key)) return this.values.get(key)!;
    let value: string | null = null;
    try { if (this.diskAllowed(key)) value = this.storage?.getItem(this.prefix + key) ?? null; } catch { /* No stored value is required to begin a new draft. */ }
    this.values.set(key, value);
    return value;
  }
  setItem(key: string, value: string): void {
    if (!this.live()) return;
    this.values.set(key, value);
    try { if (this.storage) { this.storage.setItem(this.prefix + key, value); writtenAfterClear.add(this.prefix + key); } } catch { /* Keep the same receipt and draft in memory across pane eviction. */ }
  }
  removeItem(key: string): void {
    if (!this.live()) return;
    this.values.set(key, null); writtenAfterClear.delete(this.prefix + key);
    try { this.storage?.removeItem(this.prefix + key); } catch { /* The tombstone suppresses stale disk content. */ }
  }
  clear(): void { for (const key of this.keys()) this.removeItem(key); }
  invalidate(): void {
    if (this.live()) clearNamespace(this.prefix, this.storage);
    this.values.clear(); this.invalidated = true;
  }
}
