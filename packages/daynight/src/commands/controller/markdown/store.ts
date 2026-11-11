import type Database from "better-sqlite3";

type Transactions = { read<T>(action: () => T): T; write<T>(action: () => T): T };
type MetadataBudget = { assert(additional?: number, settlement?: boolean): void };
export type MarkdownSourceStoreKind = "projection" | "source" | "context";
type RateState = { lastNow: number; requests: { host: string; at: number }[] };
const namespace = (kind: MarkdownSourceStoreKind): string => {
  if (!["projection", "source", "context"].includes(kind)) throw new Error("Invalid Markdown metadata kind.");
  return `markdown:${kind}`;
};
const identity = (id: string): string => {
  if (typeof id !== "string" || !id || !id.isWellFormed() || Buffer.byteLength(id, "utf8") > 512 || /\p{Cc}/u.test(id)) throw new Error("Invalid Markdown metadata identity.");
  return id;
};
const hostname = (host: string): string => {
  if (typeof host !== "string" || !host || !host.isWellFormed() || Buffer.byteLength(host, "utf8") > 253 || /[\s\p{Cc}]/u.test(host)) throw new Error("Invalid Markdown request host.");
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (!normalized) throw new Error("Invalid Markdown request host.");
  return normalized;
};
const clock = (now: number): number => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid Markdown request clock.");
  return now;
};

/** Metadata and request admission survive reconnects in the owning journal. */
export const createMarkdownSourceStore = (db: Database.Database, transactions: Transactions, budget: MetadataBudget) => {
  const load = (key: string): unknown => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as unknown : null;
  };
  const save = (key: string, value: unknown): void => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Markdown metadata must be JSON serializable.");
    // Include SQLite page and WAL growth rather than just the logical value.
    budget.assert(Buffer.byteLength(key) + Buffer.byteLength(encoded) + 16384);
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, encoded);
  };
  const rateState = (): RateState => {
    const value = load("markdown:rate");
    if (value === null) return { lastNow: 0, requests: [] };
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Markdown request rate metadata is corrupt.");
    const state = value as RateState;
    if (!Number.isSafeInteger(state.lastNow) || state.lastNow < 0 || !Array.isArray(state.requests) || state.requests.length > 30 || state.requests.some(item => !item || typeof item !== "object" || typeof item.host !== "string" || hostname(item.host) !== item.host || !Number.isSafeInteger(item.at) || item.at < 0 || item.at > state.lastNow)) throw new Error("Markdown request rate metadata is corrupt.");
    return state;
  };
  return {
    get<T>(kind: MarkdownSourceStoreKind, id: string): T | null {
      const key = `${namespace(kind)}:${identity(id)}`;
      return transactions.read(() => load(key) as T | null);
    },
    put(kind: MarkdownSourceStoreKind, id: string, value: unknown): void {
      const key = `${namespace(kind)}:${identity(id)}`;
      transactions.write(() => save(key, value));
    },
    list<T>(kind: MarkdownSourceStoreKind, page: { after?: string; limit: number }): { id: string; value: T }[] {
      const prefix = `${namespace(kind)}:`;
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 32) throw new Error("Invalid Markdown metadata page.");
      const after = page.after === undefined ? prefix : prefix + identity(page.after);
      return transactions.read(() => {
        const rows = db.prepare("SELECT key,value FROM image_runtime_state WHERE key>? AND key<? ORDER BY key LIMIT ?").all(after, `${namespace(kind)};`, page.limit) as { key: string; value: string }[];
        return rows.map(row => ({ id: row.key.slice(prefix.length), value: JSON.parse(row.value) as T }));
      });
    },
    listIds(kind: MarkdownSourceStoreKind, page: { after?: string; limit: number }): string[] {
      const prefix = `${namespace(kind)}:`;
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 32) throw new Error("Invalid Markdown metadata page.");
      const after = page.after === undefined ? prefix : prefix + identity(page.after);
      return transactions.read(() => {
        const rows = db.prepare("SELECT key FROM image_runtime_state WHERE key>? AND key<? ORDER BY key LIMIT ?").all(after, `${namespace(kind)};`, page.limit) as { key: string }[];
        return rows.map(row => row.key.slice(prefix.length));
      });
    },
    rate(host: string, nowMs = Date.now()): boolean {
      const currentHost = hostname(host), observed = clock(nowMs);
      return transactions.write(() => {
        const old = rateState(), now = Math.max(old.lastNow, observed);
        const requests = old.requests.filter(item => item.at > now - 60_000);
        const allowed = requests.length < 30 && requests.filter(item => item.host === currentHost).length < 10;
        if (allowed) requests.push({ host: currentHost, at: now });
        save("markdown:rate", { lastNow: now, requests });
        return allowed;
      });
    },
  };
};
export type MarkdownSourceStore = ReturnType<typeof createMarkdownSourceStore>;
