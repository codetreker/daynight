import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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
  unversioned: { validate: db => { validate(db, 1); }, adopt: () => {} },
  migrations: [{ toVersion: 2, up: db => { db.exec("ALTER TABLE records ADD COLUMN extra TEXT; UPDATE records SET data=json_set(data,'$.migrated',1);"); } }], validateVersioned: validate,
};

describe("independent SQLite format sequences", () => {
  it("initializes a baseline and pending steps together without business rows", () => {
    const db = connect();
    const result = runSqliteImmediate(db, () => upgradeSqlite(db, format, { allowEmpty: true }));
    expect(result).toEqual({ fromVersion: 0, toVersion: 2, initialized: true, adopted: false });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT * FROM records").all()).toEqual([]);
    expect(inspectSqlite(db, format, { allowEmpty: false })).toEqual({ kind: "current", version: 2 });
  });
  it("adopts unversioned rows without normalizing their JSON then applies only pending steps", () => {
    const db = connect(); format.baseline.create(db);
    db.prepare("INSERT INTO records VALUES(?,?)").run(1, '{ "value" : "kept" }');
    const baselineOnly = { ...format, migrations: [] };
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, baselineOnly, { allowEmpty: false }))).toMatchObject({ adopted: true, toVersion: 1 });
    expect(db.prepare("SELECT data FROM records").get()).toEqual({ data: '{ "value" : "kept" }' });
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, format, { allowEmpty: false }))).toMatchObject({ fromVersion: 1, toVersion: 2 });
    expect(JSON.parse((db.prepare("SELECT data FROM records").get() as { data: string }).data)).toEqual({ value: "kept", migrated: 1 });
    expect(runSqliteImmediate(db, () => upgradeSqlite(db, format, { allowEmpty: false }))).toBeNull();
  });
  it("does not confuse user names beginning sqlite with SQLite internal objects", () => {
    const db = connect(); db.exec("CREATE TABLE sqliteuser(id INTEGER)");
    expect(() => inspectSqlite(db, { ...format, unversioned: undefined } as unknown as SqliteFormat, { allowEmpty: true })).toThrow("invalid-format");
  });
  it("rejects empty query files and unknown, negative or future versions", () => {
    const db = connect();
    expect(() => inspectSqlite(db, format, { allowEmpty: false })).toThrow("invalid-format");
    for (const version of [-1, 3]) {
      db.pragma(`user_version=${version}`);
      expect(() => inspectSqlite(db, format, { allowEmpty: true })).toThrow("unsupported-version");
      expect(db.pragma("user_version", { simple: true })).toBe(version);
    }
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
  it("rolls DDL, JSON and the intermediate version back when a later step fails", () => {
    const db = connect(); format.baseline.create(db); db.pragma("user_version=1"); db.prepare("INSERT INTO records VALUES(1,?)").run('{"value":"old"}');
    const failing = { ...format, migrations: [...format.migrations, { toVersion: 3, up: (): undefined => { throw new Error("conversion failed"); } }] };
    expect(() => runSqliteImmediate(db, () => upgradeSqlite(db, failing, { allowEmpty: false }))).toThrow("migration-failed");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.pragma("table_info(records)")).toHaveLength(2);
    expect(db.prepare("SELECT data FROM records").get()).toEqual({ data: '{"value":"old"}' });
  });
  it("requires explicit transaction boundaries and detects changed versions inside them", () => {
    const db = connect();
    expect(() => upgradeSqlite(db, format, { allowEmpty: true })).toThrow("requires an immediate transaction");
    expect(() => assertCurrentSqlite(db, format)).toThrow("requires a transaction");
    runSqliteImmediate(db, () => upgradeSqlite(db, format, { allowEmpty: true }));
    runSqliteImmediate(db, () => { assertCurrentSqlite(db, format); });
    db.pragma("user_version=1");
    expect(() => runSqliteImmediate(db, () => { assertCurrentSqlite(db, format); })).toThrow("unsupported-version");
  });
});
