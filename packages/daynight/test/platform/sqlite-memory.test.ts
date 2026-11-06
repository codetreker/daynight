import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSqliteDatabase, openSqliteDatabase, readSqliteDatabase, type SqliteMigrationEvent } from "../../src/platform/sqlite-access.js";
import type { SqliteFormat } from "../../src/platform/sqlite-format.js";
import { createMemoryDatabase } from "../helpers/sqlite.js";

const connections: Database.Database[] = [];
const connect = (): Database.Database => { const db = createMemoryDatabase(); connections.push(db); return db; };
const quiet = (): undefined => {};
const format: SqliteFormat = {
  name: "memory records",
  baseline: { version: 1, create: db => { db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT"); } },
  migrations: [{ toVersion: 2, up: db => { db.exec("ALTER TABLE records ADD COLUMN extra TEXT"); } }],
  validateVersioned: (db, version) => {
    if ((db.pragma("table_info(records)") as unknown[]).length !== (version === 1 ? 2 : 3)) throw new Error("Unexpected record schema.");
  },
};
const seed = (db: Database.Database): void => {
  format.baseline.create(db);
  db.exec("INSERT INTO records VALUES (1, 'original'); PRAGMA user_version=1");
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
});

describe("supplied in-memory SQLite connections", () => {
  it("initializes the original connection and runs startup inside the migration transaction", () => {
    const db = connect(), events: SqliteMigrationEvent[] = [];
    const opened = openSqliteDatabase({
      file: db, format, allowCreate: true, timeoutMs: 17,
      onMigration: event => { events.push(event); },
      onReady: ready => { expect(ready).toBe(db); expect(ready.inTransaction).toBe(true); ready.exec("INSERT INTO records VALUES (1,'ready',NULL)"); },
    });
    expect(opened).toBe(db);
    expect(db.memory).toBe(true);
    expect(db.pragma("database_list")).toEqual([{ seq: 0, name: "main", file: "" }]);
    expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(17);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "ready", extra: null }]);
    expect(events.map(event => [event.file, event.kind, event.outcome])).toEqual([[":memory:", "started", "not-started"], [":memory:", "completed", "committed"]]);
    closeSqliteDatabase(db, { file: db, format });
    expect(db.open).toBe(false);
  });

  it("upgrades existing in-memory records without replacing the connection", () => {
    const db = connect(); seed(db);
    expect(openSqliteDatabase({ file: db, format, allowCreate: false, onMigration: quiet })).toBe(db);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "original", extra: null }]);
  });

  it("rolls startup back before closing an owned connection", () => {
    const db = connect(); seed(db);
    const primary = new Error("startup rejected"), originalClose = db.close.bind(db);
    let beforeClose: unknown;
    vi.spyOn(db, "close").mockImplementation(() => {
      beforeClose = { version: db.pragma("user_version", { simple: true }), rows: db.prepare("SELECT * FROM records").all() };
      return originalClose();
    });
    expect(() => openSqliteDatabase({ file: db, format, allowCreate: false, onMigration: quiet, onReady: ready => { ready.exec("UPDATE records SET value='changed'"); throw primary; } })).toThrow(primary);
    expect(beforeClose).toEqual({ version: 1, rows: [{ id: 1, value: "original" }] });
    expect(db.open).toBe(false);
  });

  it("closes an owned connection when initialization fails and reports its memory identity", () => {
    const db = connect(), events: SqliteMigrationEvent[] = [];
    const bad: SqliteFormat = { ...format, migrations: [{ toVersion: 2, up: () => { throw new Error("migration rejected"); } }] };
    expect(() => openSqliteDatabase({ file: db, format: bad, allowCreate: true, onMigration: event => { events.push(event); } })).toThrow(expect.objectContaining({ context: expect.objectContaining({ file: ":memory:" }), connectionClosed: true, outcome: "rolled-back" }));
    expect(events.map(event => [event.kind, event.outcome])).toEqual([["started", "not-started"], ["failed", "rolled-back"]]);
    expect(db.open).toBe(false);
  });

  it("borrows a current connection for a read-only transaction and restores write access", () => {
    const db = openSqliteDatabase({ file: connect(), format, allowCreate: true, onMigration: quiet });
    db.exec("INSERT INTO records VALUES (1,'original',NULL)");
    const options = { file: db, format, onMissing: () => null, onMigration: quiet };
    expect(readSqliteDatabase(options, snapshot => {
      expect(snapshot).toBe(db); expect(snapshot.inTransaction).toBe(true);
      expect(() => snapshot.exec("UPDATE records SET value='changed'")).toThrow(/readonly/i);
      return snapshot.prepare("SELECT value FROM records").get();
    })).toEqual({ value: "original" });
    expect(db.open).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(db.pragma("query_only", { simple: true })).toBe(0);
    db.exec("UPDATE records SET value='after read'");
    expect(db.prepare("SELECT value FROM records").get()).toEqual({ value: "after read" });
  });

  it("preserves a borrowed connection's original query-only setting", () => {
    const db = openSqliteDatabase({ file: connect(), format, allowCreate: true, onMigration: quiet });
    db.pragma("query_only = ON");
    expect(readSqliteDatabase({ file: db, format, onMissing: () => -1 }, () => 42)).toBe(42);
    expect(db.pragma("query_only", { simple: true })).toBe(1);
    expect(db.open).toBe(true);
  });

  it("preserves a borrowed reader failure and restores connection access", () => {
    const db = openSqliteDatabase({ file: connect(), format, allowCreate: true, onMigration: quiet }), primary = new Error("reader rejected");
    expect(() => readSqliteDatabase({ file: db, format, onMissing: () => null }, () => { throw primary; })).toThrow(expect.objectContaining({ cause: primary, connectionClosed: false }));
    expect(db.open).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(db.pragma("query_only", { simple: true })).toBe(0);
  });

  it("preserves reader and query-only restoration failures together", () => {
    const db = openSqliteDatabase({ file: connect(), format, allowCreate: true, onMigration: quiet });
    const primary = new Error("reader rejected"), restore = new Error("query-only restoration rejected"), pragma = db.pragma.bind(db);
    vi.spyOn(db, "pragma").mockImplementation((command, options) => {
      if (command === "query_only = 0") throw restore;
      return pragma(command, options);
    });
    expect(() => readSqliteDatabase({ file: db, format, onMissing: () => null }, () => { throw primary; })).toThrow(expect.objectContaining({ kind: "cleanup-failed", cause: expect.objectContaining({ errors: [primary, restore] }), connectionClosed: false }));
    expect(db.open).toBe(true);
    expect(db.inTransaction).toBe(false);
  });

  it("upgrades a borrowed connection and leaves it open after reading", () => {
    const db = connect(); seed(db);
    expect(readSqliteDatabase({ file: db, format, onMissing: () => null, onMigration: quiet }, snapshot => snapshot.prepare("SELECT * FROM records").get())).toEqual({ id: 1, value: "original", extra: null });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.open).toBe(true);
  });

  it("rolls back failed borrowed migrations and preserves the connection for its owner", () => {
    const db = connect(); seed(db);
    const primary = new Error("migration rejected");
    const bad: SqliteFormat = { ...format, migrations: [{ toVersion: 2, up: candidate => { candidate.exec("UPDATE records SET value='changed'"); throw primary; } }] };
    expect(() => readSqliteDatabase({ file: db, format: bad, onMissing: () => null, onMigration: quiet }, () => "unreachable")).toThrow(expect.objectContaining({ connectionClosed: false, outcome: "rolled-back" }));
    expect(db.open).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "original" }]);
  });

  it.each(["admission", "migration"] as const)("restores foreign-key enforcement after an unversioned borrowed %s failure", phase => {
    const db = connect(), primary = new Error(`${phase} rejected`);
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1)");
    const candidate: SqliteFormat = phase === "migration" ? { ...format, migrations: [{ toVersion: 2, up: () => { throw primary; } }] } : format;
    expect(() => readSqliteDatabase({
      file: db, format: candidate, onMissing: () => null, onMigration: quiet,
      assertMigrationAllowed: () => { if (phase === "admission") throw primary; },
    }, () => "unreachable")).toThrow(expect.objectContaining({ connectionClosed: false, outcome: "rolled-back" }));
    expect(db.open).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT * FROM child").all()).toEqual([{ parent_id: 1 }]);
    expect(() => db.exec("INSERT INTO child VALUES(999)")).toThrow("FOREIGN KEY constraint failed");
  });

  it("preserves unversioned admission and foreign-key restoration failures together", () => {
    const db = connect(), primary = new Error("admission rejected"), restore = new Error("foreign-key restoration rejected");
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE original(id INTEGER PRIMARY KEY)");
    const pragma = db.pragma.bind(db);
    vi.spyOn(db, "pragma").mockImplementation((command, options) => {
      if (command === "foreign_keys = 1") throw restore;
      return pragma(command, options);
    });
    expect(() => readSqliteDatabase({
      file: db, format, onMissing: () => null, onMigration: quiet, assertMigrationAllowed: () => { throw primary; },
    }, () => "unreachable")).toThrow(expect.objectContaining({
      kind: "cleanup-failed", context: expect.objectContaining({ phase: "restore-foreign-keys" }),
      cause: expect.objectContaining({ errors: [primary, restore] }), connectionClosed: false, outcome: "rolled-back",
    }));
    expect(db.open).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
  });
});
