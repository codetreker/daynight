import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCurrentSqlite, currentSqliteVersion, inspectSqlite, upgradeSqlite, type SqliteFormat, type SqliteMigration } from "../../src/platform/sqlite-format.js";
import { runSqliteImmediate } from "../../src/platform/sqlite-access.js";

const databases: Database.Database[] = [];
const connect = () => { const db = new Database(":memory:"); databases.push(db); return db; };
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
const validate = (db: Database.Database, version: number): undefined => {
  const columns = (db.pragma("table_info(records)") as { name: string }[]).map(row => row.name);
  if (columns.join(",") !== (version === 1 ? "id,data" : "id,data,extra")) throw new Error("Unexpected record layout.");
};
const format: SqliteFormat = {
  name: "test records", baseline: { version: 1, create: db => { db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;"); } },
  migrations: [{ toVersion: 2, up: db => { db.exec("ALTER TABLE records ADD COLUMN extra TEXT; UPDATE records SET data=json_set(data,'$.migrated',1);"); } }], validateVersioned: validate,
};
const userSchema = (db: Database.Database) => db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
const legacySchema = `
  CREATE TABLE "parent""quoted"(id INTEGER PRIMARY KEY AUTOINCREMENT, child_id INTEGER REFERENCES child(id) ON DELETE RESTRICT);
  CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "parent""quoted"(id));
  CREATE INDEX "old""index" ON child(parent_id);
  CREATE VIEW "old""view" AS SELECT * FROM child;
  CREATE TRIGGER "old""trigger" AFTER UPDATE ON child BEGIN SELECT 1; END;
  INSERT INTO "parent""quoted" VALUES(1,NULL);
  INSERT INTO child VALUES(1,1);
  UPDATE "parent""quoted" SET child_id=1;
`;

describe("independent SQLite format sequences", () => {
  it("initializes a baseline and pending steps together without business rows", () => {
    const db = connect();
    const result = runSqliteImmediate(db, () => upgradeSqlite(db, format));
    expect(result).toEqual({ fromVersion: 0, toVersion: 2, initialized: true, reset: false });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([]);
    expect(inspectSqlite(db, format)).toEqual({ kind: "current", version: 2 });
  });
  it.each(["known", "unknown"])("discards %s unversioned schema and data before applying the complete sequence", shape => {
    const db = connect();
    if (shape === "known") { format.baseline.create(db); db.prepare("INSERT INTO records VALUES(?,?)").run(1, '{ "value" : "old" }'); }
    else db.exec("CREATE TABLE sqliteuser(secret TEXT); INSERT INTO sqliteuser VALUES('old');");
    const validateVersioned = vi.fn(validate), current = { ...format, validateVersioned };
    expect(inspectSqlite(db, current)).toEqual({ kind: "unversioned", version: 0 });
    expect(validateVersioned).not.toHaveBeenCalled();
    db.pragma("foreign_keys=OFF");
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, current))).toEqual({ fromVersion: 0, toVersion: 2, initialized: false, reset: true });
    expect(userSchema(db).map(object => (object as { name: string }).name)).toEqual(["records"]);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([]);
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, current))).toBeNull();
  });
  it("resets quoted objects, cyclic and invalid foreign keys, virtual tables and their shadows", () => {
    const db = connect(); db.pragma("foreign_keys=ON"); db.exec(legacySchema);
    db.exec(`
      CREATE TABLE missing_parent(id INTEGER REFERENCES absent(id));
      CREATE TABLE mismatch_parent(id INTEGER);
      CREATE TABLE mismatch_child(id INTEGER REFERENCES mismatch_parent(id));
      CREATE VIRTUAL TABLE "search""old" USING fts5(content);
      INSERT INTO "search""old" VALUES('old search data');
      CREATE VIRTUAL TABLE "space""old" USING rtree(id,min_x,max_x);
      INSERT INTO "space""old" VALUES(1,0,1);
    `);
    db.pragma("foreign_keys=OFF");
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, format))).toMatchObject({ reset: true });
    expect(userSchema(db).map(object => (object as { name: string }).name)).toEqual(["records"]);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
    expect(db.prepare("SELECT * FROM sqlite_sequence").all()).toEqual([]);
  });
  it("rejects an unversioned reset when foreign keys were not disabled before the transaction", () => {
    const db = connect(); db.pragma("foreign_keys=ON"); db.exec(legacySchema); const before = db.serialize();
    let error: unknown;
    try { runSqliteImmediate(db, () => upgradeSqlite(db, format)); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: "migration-failed", context: { phase: "reset" }, cause: expect.objectContaining({ message: expect.stringContaining("foreign_keys=OFF") }) });
    expect(db.serialize()).toEqual(before); expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
  it.each(["baseline", "migration"])("restores the complete unversioned database when the %s fails", failingStep => {
    const db = connect(); db.pragma("foreign_keys=ON"); db.exec(legacySchema);
    db.exec("CREATE VIRTUAL TABLE old_search USING fts5(content); INSERT INTO old_search VALUES('original');");
    db.pragma("foreign_keys=OFF");
    const before = db.serialize();
    const failure = new Error("conversion failed");
    const failing: SqliteFormat = failingStep === "baseline"
      ? { ...format, baseline: { version: 1, create: target => { format.baseline.create(target); throw failure; } } }
      : { ...format, migrations: [...format.migrations, { toVersion: 3, up: (): undefined => { throw failure; } }] };
    expect(() => runSqliteImmediate(db, () => upgradeSqlite(db, failing))).toThrow("migration-failed");
    expect(db.serialize()).toEqual(before);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
    expect(inspectSqlite(db, format)).toEqual({ kind: "unversioned", version: 0 });
  });
  it("preserves supported versioned rows while applying only pending steps", () => {
    const db = connect(); format.baseline.create(db); db.pragma("user_version=1");
    db.prepare("INSERT INTO records VALUES(?,?)").run(1, '{ "value" : "kept" }');
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, format))).toEqual({ fromVersion: 1, toVersion: 2, initialized: false, reset: false });
    expect(JSON.parse((db.prepare("SELECT data FROM records").get() as { data: string }).data)).toEqual({ value: "kept", migrated: 1 });
    const before = db.serialize();
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, format))).toBeNull();
    expect(db.serialize()).toEqual(before);
  });
  it("classifies existing empty files and rejects negative, unsupported and invalid nonzero schemas", () => {
    const db = connect();
    expect(inspectSqlite(db, format)).toEqual({ kind: "empty", version: 0 });
    for (const version of [-1, 3]) {
      db.pragma(`user_version=${version}`); const before = db.serialize();
      expect(() => runSqliteImmediate(db, () => upgradeSqlite(db, format))).toThrow("unsupported-version");
      expect(db.serialize()).toEqual(before);
    }
    db.pragma("user_version=1"); const before = db.serialize();
    expect(() => runSqliteImmediate(db, () => upgradeSqlite(db, format))).toThrow("invalid-format");
    expect(db.serialize()).toEqual(before);
    expect(() => inspectSqlite(db, { ...format, baseline: { ...format.baseline, version: 2 }, migrations: [] })).toThrow("unsupported-version");
  });
  it.each([0, -1, 1.5, 2_147_483_648])("rejects invalid baseline %s before touching a connection", version => {
    expect(() => currentSqliteVersion({ ...format, baseline: { ...format.baseline, version } })).toThrow("positive signed 32-bit");
  });
  it("rejects missing and repeated migration versions", () => {
    for (const versions of [[3], [2, 2], [2, 4], [2, 1]]) expect(() => currentSqliteVersion({ ...format, migrations: versions.map(toVersion => ({ toVersion, up: () => {} })) })).toThrow("consecutive");
    // @ts-expect-error Async hooks must fail the synchronous migration contract.
    const invalidHook: SqliteMigration["up"] = async () => {};
    void invalidHook;
  });
  it("rolls DDL, JSON and the intermediate version back when a later versioned step fails", () => {
    const db = connect(); format.baseline.create(db); db.pragma("user_version=1"); db.prepare("INSERT INTO records VALUES(1,?)").run('{"value":"old"}');
    const failing = { ...format, migrations: [...format.migrations, { toVersion: 3, up: (): undefined => { throw new Error("conversion failed"); } }] };
    expect(() => runSqliteImmediate(db, () => upgradeSqlite(db, failing))).toThrow("migration-failed");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.pragma("table_info(records)")).toHaveLength(2);
    expect(db.prepare("SELECT data FROM records").get()).toEqual({ data: '{"value":"old"}' });
  });
  it("requires explicit transaction boundaries and detects changed versions inside them", () => {
    const db = connect();
    expect(() => upgradeSqlite(db, format)).toThrow("requires an immediate transaction");
    expect(() => assertCurrentSqlite(db, format)).toThrow("requires a transaction");
    runSqliteImmediate(db, () => upgradeSqlite(db, format));
    runSqliteImmediate(db, () => { assertCurrentSqlite(db, format); });
    db.pragma("user_version=1");
    expect(() => runSqliteImmediate(db, () => { assertCurrentSqlite(db, format); })).toThrow("unsupported-version");
  });
});

it.each(["empty", "unversioned", "outdated"] as const)("preserves the original %s source through every migration callback", kind => {
  const db = connect();
  if (kind === "unversioned") { db.pragma("foreign_keys=OFF"); db.exec("CREATE TABLE old_data(value TEXT)"); }
  if (kind === "outdated") { format.baseline.create(db); db.pragma("user_version=1"); }
  const received: unknown[] = [];
  const contextual: SqliteFormat = {
    ...format,
    migrations: [
      { toVersion: 2, up: (...args) => { received.push(args[1]); format.migrations[0]!.up(args[0], args[1]); } },
      { toVersion: 3, up: (...args) => { received.push(args[1]); } },
    ],
  };
  runSqliteImmediate(db, () => upgradeSqlite(db, contextual));
  const expected = { kind, version: kind === "outdated" ? 1 : 0 };
  expect(received).toEqual([expected, expected]);
  expect(db.pragma("user_version", { simple: true })).toBe(3);
});
