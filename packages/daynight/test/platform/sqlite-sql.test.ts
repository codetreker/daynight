import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqliteSequence, loadSqliteSql, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../src/platform/sqlite-sql.js";

import { createMemoryDatabase } from "../helpers/sqlite.js";
import { openSqliteDatabase } from "../../src/platform/sqlite-access.js";
import { currentSqliteVersion, type SqliteFormat } from "../../src/platform/sqlite-format.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

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

describe("filename-ordered SQLite SQL sequences", () => {
  const sequence = (files: readonly (readonly [string, string])[]): URL => {
    const directory = makeDirectory();
    for (const [name, sql] of files) writeFileSync(path.join(directory, name), sql);
    return pathToFileURL(directory);
  };
  it("sorts shuffled filesystem entries before deriving metadata and running actual migrations", async () => {
    const directory = sequence([
      ["003-third.sql", "UPDATE records SET value=value || '-third'; CREATE INDEX records_value ON records(value);"],
      ["001-baseline.sql", "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records VALUES(1, 'baseline');"],
      ["002-second.sql", "ALTER TABLE records ADD COLUMN extra TEXT; UPDATE records SET value=value || '-second';"],
    ]);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readdirSync).mockImplementationOnce(((directory: URL, options: { withFileTypes: true }) => actualFs.readdirSync(directory, options).sort((a, b) => a.name > b.name ? -1 : 1)) as typeof readdirSync);
    const steps = loadSqliteSequence(directory), [baseline, ...upgrades] = steps;
    expect(steps.map(step => step.version)).toEqual([1, 2, 3]);
    const schemas = sqliteSchemaSnapshots(steps);
    expect(schemas.get(1)).toHaveLength(1);
    expect(schemas.get(2)![0]!.sql).toContain("extra TEXT");
    expect(schemas.get(3)!.map(object => object.name)).toEqual(["records", "records_value"]);
    const format: SqliteFormat = {
      name: "filename-order records",
      baseline: { version: baseline.version, create: db => { db.exec(baseline.sql); } },
      migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => { db.exec(step.sql); } })),
      validateVersioned: (db, version) => {
        expect(db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[]).toEqual(schemas.get(version));
      },
    };
    const file = createMemoryDatabase();
    const db = openSqliteDatabase({ file, format, allowCreate: true, onMigration: () => {} }); connections.add(db);
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "baseline-second-third", extra: null }]);
  });
  it("uses the first filename version as the baseline and excludes unrelated files and auxiliary directories", () => {
    const directory = sequence([["006-future.sql", "ALTER TABLE records ADD COLUMN extra TEXT;"], ["005-baseline.sql", "CREATE TABLE records (id INTEGER);"]]);
    for (const name of ["README.txt", ".DS_Store", "001-baseline.sql.bak"]) writeFileSync(path.join(fileURLToPath(directory), name), "unrelated resource");
    for (const name of ["archive", "references"]) {
      mkdirSync(new URL(`${name}/`, pathToFileURL(`${fileURLToPath(directory)}${path.sep}`)));
      writeFileSync(path.join(fileURLToPath(directory), name, "000-reference.sql"), "not executable SQL");
    }
    const steps = loadSqliteSequence(directory), [baseline, ...upgrades] = steps;
    expect(steps.map(step => step.version)).toEqual([5, 6]);
    expect(currentSqliteVersion({ name: "baseline five", baseline: { version: baseline.version, create: () => {} }, migrations: upgrades.map(step => ({ toVersion: step.version, up: () => {} })), validateVersioned: () => {} })).toBe(6);
    expect([...sqliteSchemaSnapshots(steps).keys()]).toEqual([5, 6]);
  });
  it("accepts data-only upgrade scripts that leave an empty reference schema unchanged", () => {
    const steps = loadSqliteSequence(sequence([["001-baseline.sql", "CREATE TABLE records (id INTEGER);"], ["002-data.sql", "UPDATE records SET id=id+1;"]]));
    const schemas = sqliteSchemaSnapshots(steps);
    expect(schemas.get(2)).toEqual(schemas.get(1));
  });
  it.each([
    ["001-baseline.sql", "001-duplicate.sql", "Duplicate"],
    ["001-baseline.sql", "003-gap.sql", "consecutive"],
    ["0001-baseline.sql", "002-width.sql", "zero-padding width"],
  ])("rejects an invalid chain containing %s and %s", (first, second, message) => {
    const exec = vi.spyOn(Database.prototype, "exec");
    expect(() => loadSqliteSequence(sequence([[first, "CREATE TABLE records (id INTEGER);"], [second, "SELECT 1;"]]))).toThrow(message);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(["baseline.sql", "01-baseline.sql", "001-.sql", "001-Upper.sql", "001-bad_slug.sql", "001-double--word.sql", "001-baseline.SQL"])("rejects the malformed filename %s", filename => {
    const exec = vi.spyOn(Database.prototype, "exec");
    expect(() => loadSqliteSequence(sequence([[filename, "SELECT 1;"]]))).toThrow("Invalid SQLite SQL filename");
    expect(exec).not.toHaveBeenCalled();
  });
  it("rejects a directory named as a SQL resource", () => {
    const directory = sequence([["001-baseline.sql", "CREATE TABLE records (id INTEGER);"]]);
    mkdirSync(path.join(fileURLToPath(directory), "002-directory.sql"));
    expect(() => loadSqliteSequence(directory)).toThrow("Invalid SQLite SQL filename");
  });
  it.each(["000-zero.sql", "2147483648-overflow.sql"])("rejects the out-of-range version %s", filename => {
    expect(() => loadSqliteSequence(sequence([[filename, "SELECT 1;"]]))).toThrow("positive signed 32-bit integer");
  });
  it("rejects an empty sequence and an empty discovered SQL asset before database access", () => {
    const exec = vi.spyOn(Database.prototype, "exec");
    const empty = pathToFileURL(makeDirectory());
    expect(() => loadSqliteSequence(empty)).toThrow("SQLite SQL sequence is empty");
    expect(() => loadSqliteSequence(sequence([["001-baseline.sql", " \r\n\t"]]))).toThrow("SQLite SQL resource is empty");
    expect(exec).not.toHaveBeenCalled();
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
