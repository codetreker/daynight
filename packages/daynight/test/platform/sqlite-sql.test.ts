import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqliteSql, sqliteSchemaSnapshots } from "../../src/platform/sqlite-sql.js";

const temporary = fileURLToPath(new URL("../../../../.tmp/sqlite-sql-tests/", import.meta.url));
const directories: string[] = [], connections = new Set<Database.Database>();
const makeDirectory = (): string => { mkdirSync(temporary, { recursive: true }); const directory = mkdtempSync(path.join(temporary, "sql-")); directories.push(directory); return directory; };
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections) if (db.open) db.close();
  connections.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite SQL resources", () => {
  it("loads exactly the owner-selected UTF-8 URL without changing line endings", () => {
    const resource = pathToFileURL(path.join(makeDirectory(), "更新.sql"));
    const sql = "-- 更新\r\nCREATE TABLE records (id INTEGER);\r\n";
    writeFileSync(resource, sql);
    expect(loadSqliteSql(resource)).toBe(sql);
  });
  it.each(["", " \r\n\t"])("rejects an empty required SQL resource (%j)", sql => {
    const resource = pathToFileURL(path.join(makeDirectory(), "baseline-1.sql"));
    writeFileSync(resource, sql);
    expect(() => loadSqliteSql(resource)).toThrow(`SQLite SQL resource is empty: ${resource.href}`);
  });
  it("exposes a missing resource without falling back to another SQL file", () => {
    const resource = pathToFileURL(path.join(makeDirectory(), "baseline-1.sql"));
    expect(() => loadSqliteSql(resource)).toThrow(expect.objectContaining({ code: "ENOENT", path: fileURLToPath(resource) }));
  });
});

describe("SQLite reference schema snapshots", () => {
  it("derives each version from the ordered SQL and retains only immutable schema metadata", () => {
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { connections.add(this); return exec.call(this, sql); });
    const schemas = sqliteSchemaSnapshots([
      { version: 3, sql: "CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT NOT NULL CHECK(label IN ('a', 'b'))) STRICT;" },
      { version: 4, sql: "ALTER TABLE records ADD COLUMN data TEXT; CREATE INDEX records_label ON records(label); INSERT INTO records(id,label) VALUES(1,'a');" },
      { version: 5, sql: "DROP INDEX records_label; CREATE VIEW record_names AS SELECT label FROM records;" },
    ]);
    expect([...schemas.keys()]).toEqual([3, 4, 5]);
    expect(schemas.get(3)).toEqual([{ name: "records", type: "table", sql: "CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT NOT NULL CHECK(label IN ('a', 'b'))) STRICT" }]);
    expect(schemas.get(4)!.map(object => [object.name, object.type])).toEqual([["records", "table"], ["records_label", "index"]]);
    expect(schemas.get(4)![0]!.sql).toContain(", data TEXT)");
    expect(schemas.get(5)!.map(object => [object.name, object.type])).toEqual([["record_names", "view"], ["records", "table"]]);
    expect(Object.isFrozen(schemas.get(3))).toBe(true);
    expect(Object.isFrozen(schemas.get(3)![0])).toBe(true);
    expect(connections.size).toBe(1);
    for (const db of connections) { expect(db.name).toBe(":memory:"); expect(db.open).toBe(false); }
  });
  it("closes the in-memory connection and rethrows the original construction failure", () => {
    const failure = new Error("SQL construction failed"), exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { connections.add(this); if (sql === "fail") throw failure; return exec.call(this, sql); });
    expect(() => sqliteSchemaSnapshots([{ version: 1, sql: "CREATE TABLE records (id INTEGER);" }, { version: 2, sql: "fail" }])).toThrow(failure);
    expect(connections.size).toBe(1);
    for (const db of connections) expect(db.open).toBe(false);
  });
  it("preserves construction and shutdown failures together", () => {
    const failure = new Error("SQL construction failed"), shutdown = new Error("Reference shutdown failed"), close = Database.prototype.close;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database) { connections.add(this); throw failure; });
    vi.spyOn(Database.prototype, "close").mockImplementation(function(this: Database.Database) { close.call(this); throw shutdown; });
    try { sqliteSchemaSnapshots([{ version: 1, sql: "fail" }]); expect.unreachable(); }
    catch (error) { expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([failure, shutdown]); }
    for (const db of connections) expect(db.open).toBe(false);
  });
  it("exposes shutdown failure after otherwise successful schema construction", () => {
    const shutdown = new Error("Reference shutdown failed"), close = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function(this: Database.Database) { connections.add(this); close.call(this); throw shutdown; });
    expect(() => sqliteSchemaSnapshots([{ version: 1, sql: "CREATE TABLE records (id INTEGER);" }])).toThrow(shutdown);
    for (const db of connections) expect(db.open).toBe(false);
  });
});
