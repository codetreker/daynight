import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqliteSequence, loadSqliteSql, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../src/platform/sqlite-sql.js";

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

describe("filename-ordered SQLite file migrations", () => {
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
    const file = path.join(fileURLToPath(directory), "state.sqlite");
    const db = openSqliteDatabase({ file, format, allowCreate: true, onMigration: () => {} }); connections.add(db);
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "baseline-second-third", extra: null }]);
    db.close();
    const reopened = openSqliteDatabase({ file, format, allowCreate: false, onMigration: () => {} }); connections.add(reopened);
    expect(reopened.prepare("SELECT value FROM records").get()).toEqual({ value: "baseline-second-third" });
  });
});
