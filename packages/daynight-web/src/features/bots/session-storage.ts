const clearedOwners = new Set<string>();
const writtenAfterClear = new Set<string>();
const knownSessions = new Map<string, Set<string>>();
function remember(identity: string): void {
  try {
    const binding: unknown = JSON.parse(identity);
    if (!Array.isArray(binding) || binding.length !== 4 || !binding.every(value => typeof value === 'string')) return;
    const owner = binding[0] as string, session = binding[2] as string;
    const sessions = knownSessions.get(owner) ?? new Set<string>(); sessions.add(session); knownSessions.set(owner, sessions);
  } catch { /* Invalid storage keys do not identify a Session to clear. */ }
}
const ownerPrefix = (userId: string): string => `daynight:bot-session:[${JSON.stringify(userId)},`;

/** Clear this account's cold panes too, even after the Bot page has unmounted. */
export function clearBotSessionStorage(userId: string): readonly string[] {
  const prefix = ownerPrefix(userId); clearedOwners.add(prefix);
  for (const key of writtenAfterClear) if (key.startsWith(prefix)) writtenAfterClear.delete(key);
  try {
    const storage = window.sessionStorage;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) {
        const end = key.indexOf(']:');
        if (end !== -1) remember(key.slice('daynight:bot-session:'.length, end + 1));
        try { storage.removeItem(key); } catch { /* Continue clearing other owned keys. */ } }
    }
  } catch { /* The page tombstone also protects later instances when storage recovers. */ }
  const sessions = [...(knownSessions.get(userId) ?? [])]; knownSessions.delete(userId); return sessions;
}

/**
 * A Bot's draft and receipt store. Memory wins over disk after every observed
 * read/write, including failed deletes, so stale disk values cannot reappear.
 * This store never contains timeline entries, DOM, resources or command payloads.
 */
export class BotSessionStorage implements Storage {
  private readonly values = new Map<string, string | null>();
  private readonly prefix: string;
  private invalidated = false;
  constructor(identity: string, private readonly storage: Storage | null) {
    this.prefix = `daynight:bot-session:${identity}:`; remember(identity);
  }
  private diskAllowed(key: string): boolean { return writtenAfterClear.has(this.prefix + key) || ![...clearedOwners].some(prefix => this.prefix.startsWith(prefix)); }
  private keys(): string[] {
    if (this.invalidated) return [];
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
    if (this.invalidated) return null;
    if (this.values.has(key)) return this.values.get(key)!;
    let value: string | null = null;
    try { if (this.diskAllowed(key)) value = this.storage?.getItem(this.prefix + key) ?? null; } catch { /* No stored value is required to begin a new draft. */ }
    this.values.set(key, value);
    return value;
  }
  setItem(key: string, value: string): void {
    if (this.invalidated) return;
    this.values.set(key, value);
    try { if (this.storage) { this.storage.setItem(this.prefix + key, value); writtenAfterClear.add(this.prefix + key); } } catch { /* Keep the same receipt and draft in memory across pane eviction. */ }
  }
  removeItem(key: string): void {
    if (this.invalidated) return;
    this.values.set(key, null); writtenAfterClear.delete(this.prefix + key);
    try { this.storage?.removeItem(this.prefix + key); } catch { /* The tombstone suppresses stale disk content. */ }
  }
  clear(): void { for (const key of this.keys()) this.removeItem(key); }
  invalidate(): void { this.clear(); this.values.clear(); this.invalidated = true; }
}
