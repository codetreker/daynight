import type Database from "better-sqlite3";
import { parseTimelineEntry, parseStoredTimelineEntry, type TimelineEntry } from "../../../session/protocol.js";
import { SESSION_ARCHIVE_TIMELINE_MAX_BYTES } from "../../../session/archive.js";
import { controllerPayloadHash } from "../launch-ticket.js";

const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
const MAX_ENTRIES = 100_000;
const ENVELOPE_BYTES = Buffer.byteLength('{"entries":[]}');
type TimelineTables = { entries: "timeline_entries" | "online_entries"; totals: "timeline_totals" | "online_totals" };
const historyTables: TimelineTables = { entries: "timeline_entries", totals: "timeline_totals" };
const onlineTables: TimelineTables = { entries: "online_entries", totals: "online_totals" };
const columns = "id, CAST(entry_seq AS TEXT) AS entry_seq, CAST(revision AS TEXT) AS revision, kind, value, content_hash, byte_length";
type TimelineRow = { id: string; entry_seq: string; revision: string; kind: string; value: string; content_hash: string; byte_length: number };
export type TimelineTotals = { readonly entryCount: number; readonly byteLength: number; readonly timelineBytes: number };
/** Legacy callers retain full history until their live projection is independent. */
export type TimelineContentPolicy = "legacy" | "task_body" | "bot_detail";
/** Results describe the current transaction; only its caller can confirm commit. */
export type TimelineSaveResult = { readonly contentPolicy: TimelineContentPolicy; readonly status: "saved" | "unchanged" | "excluded" };
export type TimelinePageQuery = { readonly direction: "tail" | "before" | "after"; readonly pivot: string | null; readonly limit: number };
/** Verify the caller owns the original write boundary. */
export type TimelineWriteContext = { readonly assertWrite: () => void };

const sequence = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > MAX_SEQUENCE) throw new Error("Invalid SQL timeline sequence.");
  return BigInt(value);
};
const totalSize = (entryCount: number, byteLength: number): TimelineTotals => {
  if (!Number.isSafeInteger(entryCount) || entryCount < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("SQL timeline totals are corrupt.");
  const timelineBytes = ENVELOPE_BYTES + byteLength + Math.max(entryCount - 1, 0);
  if (!Number.isSafeInteger(timelineBytes)) throw new Error("SQL timeline totals are corrupt.");
  return { entryCount, byteLength, timelineBytes };
};
const decode = (row: TimelineRow): TimelineEntry => {
  const entry = parseStoredTimelineEntry(JSON.parse(row.value));
  sequence(row.entry_seq); sequence(row.revision);
  if (entry.entryId !== row.id || entry.entrySeq !== row.entry_seq || entry.revision !== row.revision || entry.kind !== row.kind
    || !Number.isSafeInteger(row.byte_length) || row.byte_length < 1 || Buffer.byteLength(row.value) !== row.byte_length
    || JSON.stringify(entry) !== row.value || controllerPayloadHash(entry) !== row.content_hash) throw new Error("SQL timeline entry differs from its stored identity or content.");
  return entry;
};
const synchronous = (value: unknown): void => {
  if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") throw new TypeError("SQL timeline traversal callbacks must be synchronous.");
};

const getRow = (db: Database.Database, tables: TimelineTables, id: string): TimelineRow | undefined => db.prepare(`SELECT ${columns} FROM ${tables.entries} WHERE id=?`).get(id) as TimelineRow | undefined;
const totals = (db: Database.Database, tables: TimelineTables): TimelineTotals => {
  const rows = db.prepare(`SELECT id,entry_count,byte_length FROM ${tables.totals}`).all() as { id: number; entry_count: number; byte_length: number }[];
  if (rows.length !== 1 || rows[0]!.id !== 1) throw new Error("SQL timeline totals are missing or corrupt.");
  return totalSize(rows[0]!.entry_count, rows[0]!.byte_length);
};

/** Publish one entry in the caller's transaction after its caller applies the appropriate admission. */
const publish = (db: Database.Database, tables: TimelineTables, value: TimelineEntry, parse: (value: unknown) => TimelineEntry, admit?: (updated: TimelineTotals) => void): "saved" | "unchanged" => {
  if (!db.inTransaction) throw new Error("SQL timeline publication requires its original journal write transaction.");
  const entry = parse(JSON.parse(JSON.stringify(value))), entrySequence = sequence(entry.entrySeq), revision = sequence(entry.revision);
  const previous = getRow(db, tables, entry.entryId), old = previous === undefined ? undefined : decode(previous);
  if (old !== undefined && (old.entrySeq !== entry.entrySeq || BigInt(old.revision) > revision)) throw new Error("SQL timeline sequence changed or revision regressed.");
  const encoded = JSON.stringify(entry), contentHash = controllerPayloadHash(entry), byteLength = Buffer.byteLength(encoded);
  if (old !== undefined && old.revision === entry.revision) {
    if (previous!.value !== encoded || previous!.content_hash !== contentHash) throw new Error("SQL timeline revision cannot change its content.");
    return "unchanged";
  }
  const current = totals(db, tables), updated = totalSize(current.entryCount + (old === undefined ? 1 : 0), current.byteLength - (previous?.byte_length ?? 0) + byteLength);
  admit?.(updated);
  db.prepare(`INSERT INTO ${tables.entries}(id,entry_seq,revision,kind,value,content_hash,byte_length) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind,value=excluded.value,content_hash=excluded.content_hash,byte_length=excluded.byte_length`)
    .run(entry.entryId, entrySequence, revision, entry.kind, encoded, contentHash, byteLength);
  const result = db.prepare(`UPDATE ${tables.totals} SET entry_count=?,byte_length=? WHERE id=1`).run(updated.entryCount, updated.byteLength);
  if (result.changes !== 1) throw new Error("SQL timeline totals were not updated.");
  return "saved";
};

/** The caller owns transactions and proves that writes belong to its original write boundary. */
const openSqlTimelineStore = (db: Database.Database, context: TimelineWriteContext, tables: TimelineTables, maxBytes: number) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < ENVELOPE_BYTES) throw new Error("Invalid SQL timeline capacity.");
  const online = tables === onlineTables;
  const get = (id: string): TimelineEntry | undefined => { const row = getRow(db, tables, id); return row === undefined ? undefined : decode(row); };
  const validate = (): void => {
    const stored = totals(db, tables);
    const actual = db.prepare(`SELECT COUNT(*) AS entry_count, COALESCE(SUM(byte_length),0) AS byte_length FROM ${tables.entries}`).get() as { entry_count: number; byte_length: number };
    if (actual.entry_count !== stored.entryCount || actual.byte_length !== stored.byteLength) throw new Error("SQL timeline totals differ from current entries.");
    for (const row of db.prepare(`SELECT ${columns} FROM ${tables.entries} ORDER BY ${tables.entries}.entry_seq`).iterate() as Iterable<TimelineRow>) decode(row);
  };
  if (db.inTransaction) validate(); else db.transaction(validate).deferred();
  const save = (value: TimelineEntry, contentPolicy: TimelineContentPolicy = "legacy"): TimelineSaveResult => {
    if (!db.inTransaction) throw new Error("SQL timeline publication requires its original journal write transaction.");
    context.assertWrite();
    if (!["legacy", "task_body", "bot_detail"].includes(contentPolicy)) throw new Error("Invalid SQL timeline content policy.");
    if (contentPolicy === "task_body" && value.kind !== "user_message" && value.kind !== "assistant_message") {
      // Excluded details still require valid structure, but never consume body
      // admission or allocate a serialized copy of large tool output.
      const excluded = parseStoredTimelineEntry(value);
      sequence(excluded.entrySeq); sequence(excluded.revision);
      if (getRow(db, tables, excluded.entryId) !== undefined) throw new Error("Excluded timeline entry cannot replace retained history.");
      return { contentPolicy, status: "excluded" };
    }
    if (online && (value.kind === "user_message" || value.kind === "assistant_message")) throw new Error("Online details cannot duplicate retained message bodies.");
    const status = publish(db, tables, value, online ? parseStoredTimelineEntry : parseTimelineEntry, updated => {
      if (updated.entryCount > MAX_ENTRIES || updated.timelineBytes > maxBytes) throw new Error(online ? "Online session detail budget exceeded." : "Pending session timeline budget exceeded.");
    });
    return { contentPolicy, status };
  };
  return {
    get,
    remove: (id: string): void => {
      context.assertWrite();
      const row = getRow(db, tables, id);
      if (!row) return;
      db.prepare(`DELETE FROM ${tables.entries} WHERE id=?`).run(id);
      db.prepare(`UPDATE ${tables.totals} SET entry_count=entry_count-1,byte_length=byte_length-? WHERE id=1`).run(row.byte_length);
    },
    has: (id: string): boolean => get(id) !== undefined,
    nextSequence: (): string => {
      const row = db.prepare(`SELECT CAST(COALESCE(MAX(entry_seq),0) AS TEXT) AS sequence FROM ${tables.entries}`).get() as { sequence: string };
      const next = BigInt(row.sequence) + 1n;
      if (next > MAX_SEQUENCE) throw new Error("SQL timeline sequence exhausted.");
      return String(next);
    },
    save,
    page: (query: TimelinePageQuery): readonly TimelineEntry[] => {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200 || !["tail", "before", "after"].includes(query.direction)) throw new Error("Invalid SQL timeline page.");
      if (query.direction === "tail" && query.pivot !== null || query.direction !== "tail" && query.pivot === null) throw new Error("Invalid SQL timeline page pivot.");
      const rows = query.direction === "tail"
        ? db.prepare(`SELECT ${columns} FROM ${tables.entries} ORDER BY ${tables.entries}.entry_seq DESC LIMIT ?`).all(query.limit)
        : db.prepare(`SELECT ${columns} FROM ${tables.entries} WHERE ${tables.entries}.entry_seq ${query.direction === "before" ? "<" : ">"} ? ORDER BY ${tables.entries}.entry_seq ${query.direction === "before" ? "DESC" : "ASC"} LIMIT ?`).all(sequence(query.pivot!), query.limit);
      const entries = (rows as TimelineRow[]).map(decode);
      return query.direction === "after" ? entries : entries.reverse();
    },
    hasBefore: (pivot: string): boolean => db.prepare(`SELECT 1 FROM ${tables.entries} WHERE entry_seq < ? LIMIT 1`).get(sequence(pivot)) !== undefined,
    hasAfter: (pivot: string): boolean => db.prepare(`SELECT 1 FROM ${tables.entries} WHERE entry_seq > ? LIMIT 1`).get(sequence(pivot)) !== undefined,
    /** Traversal is exhausted before return, within the caller's synchronous read transaction. */
    iterate: (visit: (entry: TimelineEntry) => unknown): void => {
      if (!db.inTransaction) throw new Error("SQL timeline traversal requires the original journal read transaction.");
      for (const row of db.prepare(`SELECT ${columns} FROM ${tables.entries} ORDER BY ${tables.entries}.entry_seq`).iterate() as Iterable<TimelineRow>) synchronous(visit(decode(row)));
    },
    totals: () => totals(db, tables),
  };
};
export const openTimelineStore = (db: Database.Database, context: TimelineWriteContext) => openSqlTimelineStore(db, context, historyTables, SESSION_ARCHIVE_TIMELINE_MAX_BYTES);
/** Detailed online content survives reconnects but has an independent bounded lifetime. */
export const openOnlineTimelineStore = (db: Database.Database, context: TimelineWriteContext, maxBytes = 512 * 1024 * 1024) => openSqlTimelineStore(db, context, onlineTables, maxBytes);
export type TimelineStore = ReturnType<typeof openTimelineStore>;
