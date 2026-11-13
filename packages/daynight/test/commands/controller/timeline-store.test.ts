import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { loadSqliteSql } from "../../../src/platform/sqlite-sql.js";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";

const roots: string[] = [], connections: Database.Database[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const schema = loadSqliteSql(new URL("../../../src/commands/controller/sqlite/journal/010-timeline-content.sql", import.meta.url));
const entry = (entrySeq = "1", revision = "1", text = "正文 😀", entryId: string = randomUUID()): TimelineEntry => ({ entryId, entrySeq, revision, kind: "assistant_message", content: [{ type: "text", text }] });
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "sql-timeline-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file); connections.push(db);
  db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
  db.exec("CREATE TABLE execution(id INTEGER PRIMARY KEY); CREATE TABLE content_index(id TEXT PRIMARY KEY);" + schema);
  let writing = false;
  const context = { assertWrite: () => { if (!writing) throw new Error("Not the original write transaction."); } };
  const store = openTimelineStore(db, context);
  const write = <T>(action: () => T): T => db.transaction(() => { writing = true; try { return action(); } finally { writing = false; } }).immediate();
  return { file, db, store, context, write };
};

it("stores only current UTF-8 bodies and atomically replaces their exact totals", () => {
  const f = fixture(), first = entry();
  f.write(() => f.store.save(first));
  const updated = entry("1", "2", "新正文 🧩\n", first.entryId);
  f.write(() => { f.store.save(updated); f.store.save(updated); });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM timeline_entries").get()).toEqual({ count: 1 });
  const bytes = Buffer.byteLength(JSON.stringify(updated));
  expect(f.store.get(first.entryId)).toEqual(updated);
  expect(f.store.has(first.entryId)).toBe(true);
  expect(f.store.has(randomUUID())).toBe(false);
  expect(f.store.totals()).toEqual({ entryCount: 1, byteLength: bytes, timelineBytes: Buffer.byteLength('{"entries":[]}') + bytes });
  f.db.close();
  const reopened = new Database(f.file); connections.push(reopened);
  expect(openTimelineStore(reopened, { assertWrite: () => { throw new Error("Read only."); } }).get(first.entryId)).toEqual(updated);
});

it("requires the original write boundary and rejects changed identity or stale revisions", () => {
  const f = fixture(), original = entry("1", "3");
  expect(() => f.store.save(original)).toThrow("original journal write transaction");
  expect(() => f.db.transaction(() => f.store.save(original)).deferred()).toThrow("Not the original write transaction");
  f.write(() => f.store.save(original));
  for (const invalid of [entry("2", "4", "changed sequence", original.entryId), entry("1", "2", "old revision", original.entryId), entry("1", "3", "changed body", original.entryId)]) {
    expect(() => f.write(() => f.store.save(invalid))).toThrow();
    expect(f.store.get(original.entryId)).toEqual(original);
  }
  expect(() => f.write(() => f.store.save(entry("1", "1", "duplicate sequence")))).toThrow();
  expect(f.store.totals().entryCount).toBe(1);
});

it("asks the original owner for the exact incoming JSON write allowance before mutation", () => {
  const f = fixture(), original = entry(), requests: number[] = [];
  let rejectGrowth = false;
  const store = openTimelineStore(f.db, { assertWrite: additionalBytes => {
    f.context.assertWrite(); requests.push(additionalBytes);
    if (rejectGrowth && additionalBytes > 0) throw new Error("Reserved write capacity exhausted.");
  } });
  f.write(() => store.save(original));
  expect(requests).toEqual([0, Buffer.byteLength(JSON.stringify(original)) + 16_384]);
  requests.length = 0;
  f.write(() => store.save(original));
  expect(requests).toEqual([0]);
  const priorTotals = store.totals(); rejectGrowth = true;
  expect(() => f.write(() => store.save(entry("1", "2", "replacement", original.entryId)))).toThrow("Reserved write capacity exhausted");
  expect(store.get(original.entryId)).toEqual(original); expect(store.totals()).toEqual(priorTotals);
});

it("rolls back both body and totals when updating totals fails", () => {
  const f = fixture(), original = entry(); f.write(() => f.store.save(original));
  const totals = f.store.totals();
  f.db.exec("CREATE TRIGGER reject_totals BEFORE UPDATE ON timeline_totals BEGIN SELECT RAISE(ABORT,'totals failure'); END");
  expect(() => f.write(() => f.store.save(entry("1", "2", "replacement", original.entryId)))).toThrow("totals failure");
  expect(f.store.get(original.entryId)).toEqual(original);
  expect(f.store.totals()).toEqual(totals);
});

it("preserves signed int64 sequences and revisions above JavaScript safe integers", () => {
  const f = fixture(), low = entry("9007199254740993", "9007199254740995"), high = entry("9223372036854775807", "9223372036854775807");
  f.write(() => { f.store.save(low); f.store.save(high); });
  expect(f.store.get(low.entryId)).toEqual(low);
  expect(f.store.get(high.entryId)).toEqual(high);
  expect(f.db.prepare("SELECT typeof(entry_seq) AS seq,typeof(revision) AS rev FROM timeline_entries LIMIT 1").get()).toEqual({ seq: "integer", rev: "integer" });
  expect(f.store.page({ direction: "before", pivot: high.entrySeq, limit: 1 })).toEqual([low]);
  expect(() => f.store.nextSequence()).toThrow("sequence exhausted");
  for (const invalid of ["0", "01", "9223372036854775808"]) expect(() => f.write(() => f.store.save(entry(invalid)))).toThrow();
});

it("pages in ascending sequence order with exclusive pivots and complete synchronous traversal", () => {
  const f = fixture(), entries = [1, 2, 4, 8, 16].map(value => entry(String(value)));
  expect(f.store.nextSequence()).toBe("1");
  f.write(() => { for (const value of entries) f.store.save(value); });
  expect(f.store.nextSequence()).toBe("17");
  expect(f.store.page({ direction: "tail", pivot: null, limit: 2 })).toEqual(entries.slice(3));
  expect(f.store.page({ direction: "before", pivot: "8", limit: 2 })).toEqual(entries.slice(1, 3));
  expect(f.store.page({ direction: "after", pivot: "4", limit: 2 })).toEqual(entries.slice(3));
  expect(f.store.hasBefore("1")).toBe(false); expect(f.store.hasBefore("2")).toBe(true);
  expect(f.store.hasAfter("16")).toBe(false); expect(f.store.hasAfter("8")).toBe(true);
  expect(() => f.store.iterate(() => {})).toThrow("original journal read transaction");
  const seen: TimelineEntry[] = [];
  f.db.transaction(() => f.store.iterate(value => { seen.push(value); })).deferred();
  expect(seen).toEqual(entries);
  expect(() => f.db.transaction(() => f.store.iterate(() => Promise.resolve())).deferred()).toThrow("must be synchronous");
  expect(f.db.inTransaction).toBe(false);
  for (const query of [{ direction: "tail" as const, pivot: "1", limit: 1 }, { direction: "before" as const, pivot: null, limit: 1 }, { direction: "tail" as const, pivot: null, limit: 0 }]) expect(() => f.store.page(query)).toThrow();
});

it("exposes only complete committed body and totals views to a held WAL reader", () => {
  const f = fixture(), original = entry(); f.write(() => f.store.save(original));
  const reader = new Database(f.file); connections.push(reader);
  const other = openTimelineStore(reader, { assertWrite: () => { throw new Error("Read only."); } });
  reader.exec("BEGIN DEFERRED");
  const oldTotals = other.totals(); expect(other.get(original.entryId)).toEqual(original);
  const updated = entry("1", "2", "a longer committed body", original.entryId); f.write(() => f.store.save(updated));
  expect(other.get(original.entryId)).toEqual(original); expect(other.totals()).toEqual(oldTotals);
  reader.exec("COMMIT");
  expect(other.get(original.entryId)).toEqual(updated);
  expect(other.totals().byteLength).toBe(Buffer.byteLength(JSON.stringify(updated)));
});

it.each(["id", "kind", "entry_seq", "revision", "content_hash", "byte_length", "value", "totals"])("rejects corrupt %s on reopen without repairing evidence", column => {
  const f = fixture(), original = entry(); f.write(() => f.store.save(original));
  if (column === "totals") f.db.exec("UPDATE timeline_totals SET byte_length=byte_length+1");
  else {
    const values: Record<string, string | number> = { id: randomUUID(), kind: "error", entry_seq: 2, revision: 2, content_hash: "0".repeat(64), byte_length: 1, value: "{}" };
    f.db.prepare(`UPDATE timeline_entries SET ${column}=?`).run(values[column]!);
  }
  expect(() => openTimelineStore(f.db, f.context)).toThrow();
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM timeline_entries").get()).toEqual({ count: 1 });
});
