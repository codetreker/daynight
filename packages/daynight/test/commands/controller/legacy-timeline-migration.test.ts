import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { captureCommittedPendingTimeline, migratePendingContent, migratePendingEntryPointers, preflightPendingTimeline } from "../../../src/commands/controller/pending-content.js";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import { controllerPayloadHash } from "../../../src/commands/controller/launch-ticket.js";
import { acquireControllerStoragePermit, type ControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const roots: string[] = [], connections: Database.Database[] = [], permits: ControllerStoragePermit[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) if (db.open) db.close(); for (const permit of permits.splice(0)) permit.release(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const steps = loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url));
const sql = (version: number): string => steps.find(step => step.version === version)!.sql;
const fixture = (version = 5) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/legacy-timeline-migration");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(base, "h-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file); connections.push(db); chmodSync(file, 0o600);
  for (const step of steps.filter(step => step.version <= version)) db.exec(step.sql);
  db.pragma(`user_version=${version}`);
  const sessionId = randomUUID(), pending = `${file}.pending-content`;
  const entry: TimelineEntry = { entryId: randomUUID(), entrySeq: "9007199254740993", revision: "3", kind: "reasoning", text: "original 🧪 中文" };
  const body = JSON.stringify(entry), bytes = Buffer.from("original-resource"), resource = { resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: digest(bytes), error: null };
  if (version === 5) {
    db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(?,?,?,?,?)").run(BigInt(entry.entrySeq), entry.entryId, controllerPayloadHash(entry), 3, body);
    db.prepare("INSERT INTO resources VALUES(?,?,?)").run(resource.resourceId, JSON.stringify(resource), bytes);
  } else {
    mkdirSync(path.join(pending, version < 8 ? "timeline" : "entries"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(pending, "manifest.json"), JSON.stringify({ schemaVersion: 1, sessionId }), { mode: 0o600 });
    const filename = version < 8 ? `${digest(entry.entryId)}.json` : `${randomUUID()}.json`;
    writeFileSync(path.join(pending, version < 8 ? "timeline" : "entries", filename), body, { mode: 0o600 });
    if (version < 8) db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq);
    else db.prepare("INSERT INTO content_index VALUES(?,?,?,?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq, filename, digest(body), Buffer.byteLength(body));
  }
  const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true }); permits.push(permit);
  return { root, file, db, sessionId, pending, entry, body, bytes, resource, permit };
};
const exportToV8 = (f: ReturnType<typeof fixture>): void => {
  migratePendingContent(f.db, f.sessionId, sql(6), f.permit);
  f.db.exec(sql(7));
  migratePendingEntryPointers(f.db, f.sessionId, sql(8), f.permit);
};

test("legacy SQL export preserves precise entry pointers and resources without a runtime content facade", () => {
  const f = fixture();
  f.db.transaction(() => exportToV8(f)).immediate();
  const imported: TimelineEntry[] = [];
  f.db.transaction(() => {
    expect(preflightPendingTimeline(f.db, f.sessionId)).toEqual({ entryCount: 1, byteLength: Buffer.byteLength(f.body), timelineBytes: Buffer.byteLength(f.body) + Buffer.byteLength('{"entries":[]}') });
    captureCommittedPendingTimeline(f.db, f.sessionId).iterate(entry => { imported.push(entry); });
  }).deferred();
  expect(imported).toEqual([f.entry]);
  const resources = openResourceFiles(f.file, f.sessionId), lease = resources.acquireResource(f.resource.resourceId);
  try { expect(lease.resource).toEqual(f.resource); expect(lease.read("0", f.bytes.length)).toEqual(f.bytes); } finally { lease.close(); }
  expect(existsSync(path.join(f.pending, "migration.json"))).toBe(false);
  expect(existsSync(path.join(f.pending, "legacy-sql"))).toBe(false);
});

test("rollback retains the original SQL and file exports, and a retry verifies the same source", () => {
  const f = fixture();
  expect(() => f.db.transaction(() => { exportToV8(f); throw new Error("interrupted migration"); }).immediate()).toThrow("interrupted migration");
  expect(f.db.prepare("SELECT value FROM projection").get()).toEqual({ value: f.body });
  expect(f.db.prepare("SELECT content FROM resources").get()).toEqual({ content: f.bytes });
  expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='content_index'").get()).toBeUndefined();
  expect(readFileSync(path.join(f.pending, "timeline", `${digest(f.entry.entryId)}.json`), "utf8")).toBe(f.body);
  f.db.transaction(() => exportToV8(f)).immediate();
  f.db.transaction(() => { expect(preflightPendingTimeline(f.db, f.sessionId).entryCount).toBe(1); }).deferred();
});

test("an actual file publication error preserves the original SQL source", () => {
  const f = fixture(), failure = Object.assign(new Error("device write failed"), { code: "ENOSPC" });
  vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw failure; });
  expect(() => f.db.transaction(() => migratePendingContent(f.db, f.sessionId, sql(6), f.permit)).immediate()).toThrow(failure);
  expect(f.db.prepare("SELECT value FROM projection").get()).toEqual({ value: f.body });
  expect(f.db.prepare("SELECT content FROM resources").get()).toEqual({ content: f.bytes });
  expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='content_index'").get()).toBeUndefined();
});

test("captured committed pointer metadata supports complete DDL index removal and rechecks the original file", () => {
  const f = fixture(8);
  f.db.transaction(() => {
    const captured = captureCommittedPendingTimeline(f.db, f.sessionId);
    f.db.exec("DROP TABLE content_index");
    const entries: TimelineEntry[] = [];
    captured.iterate(entry => { entries.push(entry); });
    expect(entries).toEqual([f.entry]);
    const filename = readdirSync(path.join(f.pending, "entries"))[0]!;
    writeFileSync(path.join(f.pending, "entries", filename), JSON.stringify({ ...f.entry, text: "uncommitted" }), { mode: 0o600 });
    expect(() => captured.iterate(() => {})).toThrow(/corrupt/);
  }).immediate();
});


test.skipIf(process.platform === "win32")("legacy mutable sources retain before/after fd identity and preserve a close failure with the primary error", () => {
  const f = fixture(6), file = path.join(f.pending, "timeline", `${digest(f.entry.entryId)}.json`), open = fs.openSync, close = fs.closeSync;
  let originalFd: number | undefined;
  vi.spyOn(fs, "openSync").mockImplementation((source, flags, mode) => {
    const fd = open(source, flags, mode);
    if (source === file) { originalFd = fd; fs.renameSync(file, `${file}.original`); fs.writeFileSync(file, f.body, { mode: 0o600 }); }
    return fd;
  });
  vi.spyOn(fs, "closeSync").mockImplementation(fd => { close(fd); if (fd === originalFd) throw new Error("close result lost"); });
  let failure: unknown;
  try { f.db.transaction(() => migratePendingEntryPointers(f.db, f.sessionId, sql(8), f.permit)).immediate(); } catch (cause) { failure = cause; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map(error => error.message)).toEqual(["Pending archive entry changed while being read.", "close result lost"]);
  expect(readdirSync(path.join(f.pending, "entries"))).toEqual([]);
  expect(readFileSync(`${file}.original`, "utf8")).toBe(f.body); expect(readFileSync(file, "utf8")).toBe(f.body);
  expect(f.db.prepare("SELECT id,revision,entry_seq FROM content_index").get()).toEqual({ id: f.entry.entryId, revision: f.entry.revision, entry_seq: f.entry.entrySeq });
});

test("file write, close and cleanup failures retain the complete error chain", () => {
  const f = fixture(), open = fs.openSync, close = fs.closeSync, unlink = fs.unlinkSync;
  let targetFd: number | undefined;
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    const fd = open(file, flags, mode);
    if (typeof file === "string" && file.includes(`${path.sep}timeline${path.sep}`) && file.endsWith(".tmp")) targetFd = fd;
    return fd;
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (fd === targetFd) throw new Error("write sync failed"); });
  vi.spyOn(fs, "closeSync").mockImplementation(fd => { close(fd); if (fd === targetFd) throw new Error("close failed"); });
  vi.spyOn(fs, "unlinkSync").mockImplementation(file => { if (typeof file === "string" && file.includes(`${path.sep}timeline${path.sep}`) && file.endsWith(".tmp")) throw new Error("cleanup failed"); unlink(file); });
  let failure: unknown;
  try { f.db.transaction(() => migratePendingContent(f.db, f.sessionId, sql(6), f.permit)).immediate(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  const outer = failure as AggregateError, inner = outer.errors[0] as AggregateError;
  expect(outer.errors[1].message).toBe("cleanup failed");
  expect(inner.errors.map(error => error.message)).toEqual(["write sync failed", "close failed"]);
  expect(f.db.prepare("SELECT value FROM projection").get()).toEqual({ value: f.body });
});

test("empty v5 sources do not access an unrelated pending root", () => {
  const f = fixture();
  f.db.exec("DELETE FROM projection; DELETE FROM resources");
  writeFileSync(f.pending, "unrelated", { mode: 0o600 });
  f.db.transaction(() => migratePendingContent(f.db, f.sessionId, sql(6), f.permit)).immediate();
  expect(readFileSync(f.pending, "utf8")).toBe("unrelated");
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM content_index").get()).toEqual({ count: 0 });
});

test("v5 projection does not inspect or rewrite an unrelated resource index", () => {
  const f = fixture(); f.db.exec("DELETE FROM resources");
  mkdirSync(f.pending, { mode: 0o700 });
  const index = path.join(f.pending, "index.json"); writeFileSync(index, "not valid JSON", { mode: 0o600 });
  f.db.transaction(() => migratePendingContent(f.db, f.sessionId, sql(6), f.permit)).immediate();
  expect(readFileSync(index, "utf8")).toBe("not valid JSON");
  expect(f.db.prepare("SELECT id FROM content_index").get()).toEqual({ id: f.entry.entryId });
});


test.skipIf(process.platform === "win32")("empty v5 sources leave an unrelated dangling symlink untouched", () => {
  const f = fixture(); f.db.exec("DELETE FROM projection; DELETE FROM resources");
  fs.symlinkSync(path.join(f.root, "missing-target"), f.pending);
  f.db.transaction(() => migratePendingContent(f.db, f.sessionId, sql(6), f.permit)).immediate();
  expect(fs.lstatSync(f.pending).isSymbolicLink()).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM content_index").get()).toEqual({ count: 0 });
});
