import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { loadSqliteSql } from "../../../src/platform/sqlite-sql.js";
import { controllerPayloadHash } from "../../../src/commands/controller/launch-ticket.js";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";
import { SESSION_ARCHIVE_TIMELINE_MAX_BYTES } from "../../../src/session/archive.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const schema = loadSqliteSql(new URL("../../../src/commands/controller/sqlite/journal/010-timeline-content.sql", import.meta.url));
const roots: string[] = [], connections: Database.Database[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const entry = (number: number, revision = 1, text = "content"): TimelineEntry => ({ entryId: id(number), entrySeq: String(number), revision: String(revision), kind: "assistant_message", content: [{ type: "text", text }] });
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/timeline-capacity"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "s-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file); connections.push(db);
  db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL"); db.pragma("wal_autocheckpoint=1000");
  db.exec("CREATE TABLE execution(id INTEGER PRIMARY KEY); CREATE TABLE content_index(id TEXT PRIMARY KEY); CREATE TABLE outbox(sequence INTEGER PRIMARY KEY,value TEXT NOT NULL);" + schema);
  let writing = false;
  const context = { assertWrite: () => { if (!writing) throw new Error("Not the original write transaction."); } };
  const store = openTimelineStore(db, context);
  const write = <T>(action: () => T): T => db.transaction(() => { writing = true; try { return action(); } finally { writing = false; } }).immediate();
  const physical = (): number => ["", "-wal", "-shm"].reduce((sum, suffix) => {
    try { return sum + lstatSync(file + suffix).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return sum; throw error; }
  }, 0);
  return { file, db, store, context, write, physical };
};

it("keeps exact 100000 current entries and rejects one additional entry without changing totals", () => {
  const f = fixture();
  f.write(() => { for (let index = 1; index <= 100000; index++) f.store.save(entry(index)); });
  expect(f.store.totals().entryCount).toBe(100000);
  expect(f.store.nextSequence()).toBe("100001");
  f.write(() => f.store.save(entry(50000, 2, "replacement")));
  const totals = f.store.totals();
  expect(() => f.write(() => f.store.save(entry(100001)))).toThrow("timeline budget");
  expect(f.store.totals()).toEqual(totals);
  expect(f.store.has(id(100001))).toBe(false);
  f.db.pragma("wal_checkpoint(TRUNCATE)");
  expect(f.physical()).toBeLessThan(128 * 1048576);
  const reopened = openTimelineStore(f.db, f.context);
  let count = 0;
  f.db.transaction(() => reopened.iterate(value => {
    count++;
    expect(value.entryId).toBe(id(count));
    expect(value.entrySeq).toBe(String(count));
    expect(value.revision).toBe(count === 50000 ? "2" : "1");
  })).deferred();
  expect(count).toBe(100000);
}, 120000);

it("accepts the exact 128 MiB UTF-8 envelope and rejects a one-byte replacement growth", () => {
  const f = fixture(), maximum = SESSION_ARCHIVE_TIMELINE_MAX_BYTES, count = 256;
  const available = maximum - Buffer.byteLength('{"entries":[]}') - (count - 1);
  let written = 0;
  f.write(() => {
    for (let index = 1; index <= count; index++) {
      const desired = index === count ? available - written : Math.floor(available / count);
      const empty = entry(index, 1, "界");
      const value = entry(index, 1, "界" + "x".repeat(desired - Buffer.byteLength(JSON.stringify(empty))));
      f.store.save(value); written += Buffer.byteLength(JSON.stringify(value));
    }
  });
  expect(f.store.totals()).toEqual({ entryCount: count, byteLength: available, timelineBytes: maximum });
  const last = f.store.get(id(count))!;
  if (last.kind !== "assistant_message" || last.content[0]?.type !== "text") throw new Error("Unexpected boundary fixture.");
  const oversized = entry(count, 2, last.content[0].text + "x");
  expect(() => f.write(() => f.store.save(oversized))).toThrow("timeline budget");
  expect(f.store.get(id(count))).toEqual(last);
  expect(f.store.totals().timelineBytes).toBe(maximum);
  f.db.pragma("wal_checkpoint(TRUNCATE)");
  expect(f.physical()).toBeLessThan(256 * 1048576);
  expect(openTimelineStore(f.db, f.context).totals().timelineBytes).toBe(maximum);
}, 120000);

it.each(["acknowledged", "offline-outbox", "held-reader"] as const)("verifies all 989 generated revisions with %s conditions", condition => {
  const f = fixture(), source = createHash("sha256"), start = performance.now();
  let reader: Database.Database | undefined, peakBytes = f.physical(), final: TimelineEntry | undefined;
  if (condition === "held-reader") {
    reader = new Database(f.file); connections.push(reader);
    reader.exec("BEGIN DEFERRED"); reader.prepare("SELECT COUNT(*) FROM timeline_entries").get();
  }
  for (let revision = 1; revision <= 989; revision++) {
    const text = `Generated representative revision ${revision}: 界😀\n` + "x".repeat(1024 + revision * 23);
    const value = entry(1, revision, text), encoded = JSON.stringify(value);
    source.update(`${Buffer.byteLength(encoded)}:`); source.update(encoded);
    f.write(() => {
      f.store.save(value);
      f.db.prepare("INSERT INTO outbox(sequence,value) VALUES(?,?)").run(revision, encoded);
      if (condition !== "offline-outbox") f.db.prepare("DELETE FROM outbox WHERE sequence<=?").run(revision);
    });
    expect(f.store.get(value.entryId)).toEqual(value);
    expect(f.db.prepare("SELECT content_hash,CAST(entry_seq AS TEXT) AS seq,CAST(revision AS TEXT) AS rev FROM timeline_entries").get())
      .toEqual({ content_hash: controllerPayloadHash(value), seq: "1", rev: String(revision) });
    expect(f.store.totals().byteLength).toBe(Buffer.byteLength(encoded));
    peakBytes = Math.max(peakBytes, f.physical()); final = value;
  }
  if (reader !== undefined) {
    expect(f.db.pragma("wal_checkpoint(TRUNCATE)")).toMatchObject([{ busy: 1 }]);
    reader.exec("COMMIT"); reader.close();
  }
  expect(f.db.pragma("wal_checkpoint(TRUNCATE)")).toMatchObject([{ busy: 0, log: 0, checkpointed: 0 }]);
  expect(openTimelineStore(f.db, f.context).get(id(1))).toEqual(final);
  expect(f.store.totals().entryCount).toBe(1);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: condition === "offline-outbox" ? 989 : 0 });
  process.stdout.write(JSON.stringify({ kind: "generated-timeline-probe", condition, revisions: 989, generator: "fixed-entry-growing-utf8-v1", sourceSha256: source.digest("hex"), finalHash: controllerPayloadHash(final), finalRevision: final!.revision, finalSequence: final!.entrySeq, finalRows: 1, peakDbWalShmBytes: peakBytes, settledDbWalShmBytes: f.physical(), durationMs: performance.now() - start, outboxAcknowledgement: condition === "offline-outbox" ? "none; all SQL rows retained" : "SQL rows deleted in original write transaction", relay: "not connected", originalIncidentReplay: false }) + "\n");
}, 120000);
