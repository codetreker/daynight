import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { initializeOutboxAccounting } from "../../../src/commands/controller/outbox-migration.js";
import { openControllerOutbox, readControllerOutboxByteLength } from "../../../src/commands/controller/outbox-store.js";

const sql = readFileSync(new URL("../../../src/commands/controller/sqlite/journal/011-outbox-accounting.sql", import.meta.url), "utf8");
const databases: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = (encoding?: "UTF-8" | "UTF-16le") => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/outbox-store", randomUUID());
  mkdirSync(root, { recursive: true }); roots.push(root);
  const db = new Database(path.join(root, "journal.sqlite")); databases.push(db);
  if (encoding !== undefined) db.pragma(`encoding = '${encoding}'`);
  db.exec("CREATE TABLE outbox(sequence INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  return db;
};
const storeFor = (db: Database.Database) => openControllerOutbox(db, { assertWrite: () => { if (!db.inTransaction) throw new Error("write ownership required"); } });
const actualBytes = (db: Database.Database) => (db.prepare("SELECT value FROM outbox ORDER BY sequence").all() as { value: string }[]).reduce((sum, row) => sum + Buffer.byteLength(row.value, "utf8"), 0);

test.each(["UTF-8", "UTF-16le"] as const)("migration and all mutations use UTF-8 bytes for %s files", encoding => {
  const db = fixture(encoding), original = ['{"text":"中文😀"}', '{"text":"\\n\\\""}', '{"value":"再见"}'];
  original.forEach((value, index) => db.prepare("INSERT INTO outbox VALUES(?,?)").run(index + 1, value));
  db.transaction(() => initializeOutboxAccounting(db, sql)).immediate();
  const store = storeFor(db);
  expect(String(db.pragma("encoding", { simple: true })).toLowerCase()).toBe(encoding.toLowerCase());
  expect(store.byteLength()).toBe(actualBytes(db));
  db.transaction(() => store.append(4n, '{"text":"新增🐈"}')).immediate();
  expect(store.byteLength()).toBe(actualBytes(db));
  expect(store.pending(null, 2).map(row => row.sequence)).toEqual(["1", "2"]);
  expect(store.pending(2n, 9).map(row => row.sequence)).toEqual(["3", "4"]);
  expect(store.valueAt(3n)).toBe(original[2]);
  expect(store.valueAt(99n)).toBeUndefined();
  db.transaction(() => store.acknowledgeThrough(2n)).immediate();
  expect(store.byteLength()).toBe(actualBytes(db));
  const remaining = store.byteLength();
  db.transaction(() => { store.acknowledgeThrough(2n); store.acknowledgeThrough(1n); }).immediate();
  expect(store.byteLength()).toBe(remaining);
  db.transaction(() => store.acknowledgeThrough(100n)).immediate();
  expect(store.byteLength()).toBe(0);
  db.transaction(() => { store.acknowledgeThrough(100n); store.append(8n, '{"x":1}'); store.clear(); }).immediate();
  expect(store.byteLength()).toBe(0);
  db.close();
  const reopened = new Database(path.join(path.dirname(db.name), "journal.sqlite"), { readonly: true }); databases.push(reopened);
  expect(readControllerOutboxByteLength(reopened)).toBe(0);
});

test("enforces write ownership and rejects duplicate sequences without replacing data", () => {
  const db = fixture(); db.exec(sql); const store = storeFor(db);
  expect(() => store.append(1n, '{"first":true}')).toThrow("write ownership required");
  db.transaction(() => store.append(1n, '{"first":true}')).immediate();
  expect(() => db.transaction(() => store.append(1n, '{"second":true}')).immediate()).toThrow();
  expect(store.valueAt(1n)).toBe('{"first":true}');
  expect(store.byteLength()).toBe(actualBytes(db));
});

test("pending pages preserve numeric sequence order across decimal widths", () => {
  const db = fixture(); db.exec(sql); const store = storeFor(db);
  db.transaction(() => { for (const sequence of [1n, 2n, 10n, 11n, 100n]) store.append(sequence, "{}"); }).immediate();
  expect(store.pending(null, 10).map(row => row.sequence)).toEqual(["1", "2", "10", "11", "100"]);
  expect(store.pending(1n, 3).map(row => row.sequence)).toEqual(["2", "10", "11"]);
});

test("rejects missing and contradictory metadata and underflow", () => {
  const db = fixture(); db.exec(sql); const store = storeFor(db);
  db.exec("DELETE FROM outbox_totals");
  expect(() => store.byteLength()).toThrow(expect.objectContaining({ kind: "invalid-format", outcome: "unknown" }));
  expect(() => db.transaction(() => store.acknowledgeThrough(3n)).immediate()).toThrow("outbox-ack");
  db.exec("INSERT INTO outbox_totals VALUES(1,1)");
  expect(() => store.byteLength()).toThrow("invalid-format");
  db.exec("INSERT INTO outbox VALUES(1, 'long text'),(2,'retained')");
  expect(() => db.transaction(() => store.acknowledgeThrough(1n)).immediate()).toThrow("outbox-ack");
  expect(db.prepare("SELECT count(*) AS n FROM outbox").get()).toEqual({ n: 2 });
  db.exec("PRAGMA ignore_check_constraints=ON; UPDATE outbox_totals SET byte_length=9007199254740992");
  expect(() => store.byteLength()).toThrow("invalid-format");
});

test.each(["append", "ack", "clear"] as const)("%s failure between row and total changes rolls back both", operation => {
  const db = fixture(); db.exec(sql); const store = storeFor(db);
  db.transaction(() => { store.append(1n, '{"one":1}'); store.append(2n, '{"two":2}'); }).immediate();
  const original = store.pending(null, 10), total = store.byteLength();
  db.exec("CREATE TRIGGER fail_total BEFORE UPDATE ON outbox_totals BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(() => db.transaction(() => {
    if (operation === "append") store.append(3n, '{"three":3}');
    else if (operation === "ack") store.acknowledgeThrough(1n);
    else store.clear();
  }).immediate()).toThrow("injected");
  expect(store.pending(null, 10)).toEqual(original);
  expect(store.byteLength()).toBe(total);
});

test("outer rollback and nested savepoint restore the same queue and total", () => {
  const db = fixture(); db.exec(sql); const store = storeFor(db);
  db.transaction(() => store.append(1n, '{"one":1}')).immediate();
  const total = store.byteLength();
  expect(() => db.transaction(() => {
    db.transaction(() => store.append(2n, '{"two":2}'))();
    throw new Error("outer rollback");
  }).immediate()).toThrow("outer rollback");
  expect(store.byteLength()).toBe(total);
  expect(store.pending(null, 10).map(row => row.sequence)).toEqual(["1"]);
  db.transaction(() => {
    expect(() => db.transaction(() => { store.clear(); throw new Error("savepoint rollback"); })()).toThrow("savepoint rollback");
    expect(store.byteLength()).toBe(total);
  }).immediate();
});

test("migration failure rolls back schema and retains the original rows", () => {
  const db = fixture(); db.exec("INSERT INTO outbox VALUES(1,'原始😀')");
  const failingSql = `${sql}\nCREATE TRIGGER fail_total BEFORE UPDATE ON outbox_totals BEGIN SELECT RAISE(ABORT, 'injected'); END;`;
  expect(() => db.transaction(() => initializeOutboxAccounting(db, failingSql)).immediate()).toThrow("injected");
  expect(db.prepare("SELECT value FROM outbox").get()).toEqual({ value: "原始😀" });
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='outbox_totals'").get()).toBeUndefined();
});

test("partial acknowledgement uses the sequence primary-key range", () => {
  const db = fixture(); db.exec(sql);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT value FROM outbox WHERE sequence<=? ORDER BY sequence").all(3) as { detail: string }[];
  expect(plan.some(row => /SEARCH outbox USING INTEGER PRIMARY KEY/i.test(row.detail))).toBe(true);
});

test("capacity, append, partial and full acknowledgement do not read retained payloads", () => {
  const db = fixture(); db.exec(sql); const store = storeFor(db);
  db.transaction(() => { for (let sequence = 1n; sequence <= 20n; sequence++) store.append(sequence, JSON.stringify({ sequence: String(sequence) })); }).immediate();
  const prepare = vi.spyOn(Database.prototype, "prepare");
  store.byteLength();
  db.transaction(() => { store.append(21n, '{}'); store.acknowledgeThrough(2n); store.acknowledgeThrough(21n); }).immediate();
  const statements = prepare.mock.calls.map(([statement]) => statement);
  expect(statements.filter(statement => /^SELECT value FROM outbox/i.test(statement))).toEqual(["SELECT value FROM outbox WHERE sequence<=? ORDER BY sequence"]);
  expect(statements.some(statement => /SUM\(|COUNT\(|CAST\(value AS BLOB\)/i.test(statement))).toBe(false);
});
