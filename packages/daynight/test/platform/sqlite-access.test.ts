import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqliteDatabase, readSqliteDatabase, runSqliteImmediate, type SqliteMigrationReporter, type SqliteMigrationEvent } from "../../src/platform/sqlite-access.js";
import { MaintenanceLockHeldError } from "../../src/platform/instance-lock.js";
import { serializeSqliteError, SqliteAccessError } from "../../src/platform/sqlite-error.js";
import type { SqliteFormat } from "../../src/platform/sqlite-format.js";

const temporary = fileURLToPath(new URL("../../../../.tmp/sqlite-core-tests/", import.meta.url));
const directories: string[] = [], connections = new Set<Database.Database>();
const quiet: SqliteMigrationReporter = () => {};
const makeFile = (): string => { mkdirSync(temporary, { recursive: true }); const dir = mkdtempSync(path.join(temporary, "db-")); directories.push(dir); return path.join(dir, "state.sqlite"); };
const connect = (file: string): Database.Database => { const db = new Database(file); connections.add(db); return db; };
const baseline = (db: Database.Database): undefined => { db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT"); };
const format: SqliteFormat = {
  name: "test records", baseline: { version: 1, create: baseline }, migrations: [{ toVersion: 2, up: db => { db.exec("ALTER TABLE records ADD COLUMN extra TEXT"); } }],
  validateVersioned: (db, version) => { if ((db.pragma("table_info(records)") as unknown[]).length !== (version === 1 ? 2 : 3)) throw new Error("Unexpected schema."); },
};
const seed = (file: string): void => { const db = connect(file); baseline(db); db.exec("INSERT INTO records VALUES(1,'committed')"); db.pragma("user_version=1"); db.close(); };
afterEach(() => { vi.restoreAllMocks(); for (const db of connections) if (db.open) db.close(); connections.clear(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("SQLite access lifecycle", () => {
  it("upgrades before a read, closes migration resources, then reads exactly once", () => {
    const file = makeFile(); seed(file); const release = vi.fn(), acquire = vi.fn(() => ({ owner: "maintenance", release })); const read = vi.fn((db: Database.Database) => db.prepare("SELECT * FROM records").all()); const events: SqliteMigrationEvent[] = [];
    expect(readSqliteDatabase({ file, format, onMissing: () => [], acquireMaintenance: acquire, onMigration: event => { events.push(event); } }, read)).toEqual([{ id: 1, value: "committed", extra: null }]);
    expect(acquire).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
    expect(events.map(e => [e.kind, e.outcome])).toEqual([["started", "not-started"], ["completed", "committed"]]);
  });
  it("keeps preflight version and schema in one snapshot while another reader upgrades", () => {
    const file = makeFile(); seed(file);
    const wal = connect(file); wal.pragma("journal_mode = WAL"); wal.close();
    const steps: number[] = [];
    const competing: SqliteFormat = {
      ...format,
      migrations: [2, 3, 4, 5].map(toVersion => ({ toVersion, up: db => { db.exec(`ALTER TABLE records ADD COLUMN extra${toVersion} TEXT`); steps.push(toVersion); } })),
      validateVersioned: (db, version) => {
        const actual = (db.pragma("table_info(records)") as { name: string }[]).map(row => row.name);
        const expected = ["id", "value", ...Array.from({ length: version - 1 }, (_value, index) => `extra${index + 2}`)];
        if (actual.join(",") !== expected.join(",")) throw new Error("Version and record layout disagree.");
      },
    };
    const read = (db: Database.Database): string => (db.prepare("SELECT value FROM records WHERE id=1").get() as { value: string }).value;
    const options = { file, format: competing, onMissing: () => "missing", onMigration: quiet };
    const pragma = Database.prototype.pragma;
    let interleaved = false, preflightInTransaction = false, second: string | undefined;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function(this: Database.Database, command: string, pragmaOptions?: Database.PragmaOptions) {
      const value = pragma.call(this, command, pragmaOptions);
      if (!interleaved && this.name === file && !this.readonly && command === "user_version") {
        interleaved = true; preflightInTransaction = this.inTransaction;
        second = readSqliteDatabase(options, read);
      }
      return value;
    });
    expect(readSqliteDatabase(options, read)).toBe("committed");
    expect(second).toBe("committed"); expect(preflightInTransaction).toBe(true);
    expect(steps).toEqual([2, 3, 4, 5]);
    const db = connect(file); expect(db.pragma("user_version", { simple: true })).toBe(5); expect(db.pragma("table_info(records)")).toHaveLength(6);
  });
  it("preserves preflight validation, rollback and close failures together", () => {
    const file = makeFile(); seed(file);
    const validation = new Error("preflight validation failed"), rollback = new Error("preflight rollback failed"), close = new Error("preflight close failed");
    const bad: SqliteFormat = { ...format, validateVersioned: () => { throw validation; } };
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { connections.add(this); if (sql === "ROLLBACK") throw rollback; return exec.call(this, sql); });
    vi.spyOn(Database.prototype, "close").mockImplementation(function(this: Database.Database) { connections.add(this); throw close; });
    let error: unknown;
    try { openSqliteDatabase({ file, format: bad, allowEmpty: false, onMigration: quiet }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: "invalid-format", context: { phase: "rollback", fromVersion: 1 }, outcome: "unknown", connectionClosed: false });
    const causes: unknown[] = [];
    const collect = (value: unknown): void => { causes.push(value); if (value instanceof AggregateError) value.errors.forEach(collect); if (value instanceof Error && value.cause !== undefined) collect(value.cause); };
    collect(error); expect(causes).toContain(validation); expect(causes).toContain(rollback); expect(causes).toContain(close);
  });
  it("reads the current committed WAL snapshot without maintenance or a writer connection", () => {
    const file = makeFile(); const writer = openSqliteDatabase({ file, format, allowEmpty: true, onMigration: quiet }); connections.add(writer);
    writer.exec("INSERT INTO records(id,value) VALUES(1,'committed'); BEGIN IMMEDIATE; UPDATE records SET value='uncommitted'");
    const acquire = vi.fn(() => { throw new Error("Maintenance must not run."); }), report = vi.fn();
    expect(readSqliteDatabase({ file, format, onMissing: () => "missing", acquireMaintenance: acquire, onMigration: report }, db => (db.prepare("SELECT value FROM records").get() as { value: string }).value)).toBe("committed");
    expect(acquire).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled(); writer.exec("ROLLBACK");
  });
  it("preserves missing semantics without creating files or confusing invalid parents", () => {
    const file = makeFile(), missing = path.join(path.dirname(file), "absent", "journal.sqlite");
    expect(readSqliteDatabase({ file: missing, format, onMissing: () => null }, () => "not read")).toBeNull(); expect(existsSync(path.dirname(missing))).toBe(false);
    writeFileSync(file, "parent");
    expect(() => readSqliteDatabase({ file: path.join(file, "child"), format, onMissing: () => null }, () => null)).toThrow();
  });
  it("does not initialize an existing empty file from a query", () => {
    const file = makeFile(); connect(file).close();
    expect(() => readSqliteDatabase({ file, format, onMissing: () => null }, () => null)).toThrow("invalid-format");
    const db = connect(file); expect(db.pragma("user_version", { simple: true })).toBe(0); expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
  });
  it("rechecks readonly once if another owner upgraded before maintenance admission", () => {
    const file = makeFile(); seed(file); const acquire = vi.fn(() => { const db = openSqliteDatabase({ file, format, allowEmpty: false, onMigration: quiet }); db.close(); throw new MaintenanceLockHeldError("instance.lock"); });
    expect(readSqliteDatabase({ file, format, onMissing: () => null, acquireMaintenance: acquire }, db => db.pragma("user_version", { simple: true }))).toBe(2);
    expect(acquire).toHaveBeenCalledOnce();
  });
  it("does not hide maintenance resource failures behind a now-current snapshot", () => {
    const file = makeFile(); seed(file); const closeFailure = new Error("gate close outcome unknown");
    const acquire = () => { const db = openSqliteDatabase({ file, format, allowEmpty: false, onMigration: quiet }); db.close(); throw closeFailure; };
    let error: unknown;
    try { readSqliteDatabase({ file, format, onMissing: () => null, acquireMaintenance: acquire }, () => "current"); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ cause: closeFailure, connectionClosed: false });
  });
  it("reports an actual maintenance blocker without executing the business read", () => {
    const file = makeFile(); seed(file); const blocker = new Error("Existing lock retained"), read = vi.fn();
    expect(() => readSqliteDatabase({ file, format, onMissing: () => null, acquireMaintenance: () => { throw blocker; } }, read)).toThrow("upgrade-blocked"); expect(read).not.toHaveBeenCalled();
    expect(connect(file).pragma("user_version", { simple: true })).toBe(1);
  });
  it("classifies release failure as cleanup while retaining the original migration error", () => {
    const file = makeFile(); seed(file); const releaseFailure = new Error("release failed"), conversion = new SyntaxError("stored payload");
    const bad: SqliteFormat = { ...format, migrations: [{ toVersion: 2, up: () => { throw conversion; } }] };
    let error: unknown;
    try { readSqliteDatabase({ file, format: bad, onMissing: () => null, onMigration: quiet, acquireMaintenance: () => ({ owner: "ours", release: () => { throw releaseFailure; } }) }, () => null); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: "cleanup-failed", context: { phase: "release", stepVersion: 2 }, outcome: "rolled-back" });
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors[1]).toBe(releaseFailure);
  });
  it("retains the permit for rollback uncertainty even when the connection subsequently closes", () => {
    const file = makeFile(); seed(file); const release = vi.fn(); const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) {
      connections.add(this);
      if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error(`${sql} uncertain`);
      return exec.call(this, sql);
    });
    expect(() => readSqliteDatabase({ file, format, onMissing: () => null, onMigration: quiet, acquireMaintenance: () => ({ owner: "ours", release }) }, () => null)).toThrow("migration-failed");
    expect(release).not.toHaveBeenCalled();
  });
  it("does not report rollback after a committed migration whose close fails", () => {
    const file = makeFile(); seed(file); const release = vi.fn(), close = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function(this: Database.Database) { connections.add(this); if (!this.readonly) throw new Error("close failed"); return close.call(this); });
    let error: unknown;
    try { readSqliteDatabase({ file, format, onMissing: () => null, onMigration: quiet, acquireMaintenance: () => ({ owner: "ours", release }) }, () => null); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: "cleanup-failed", outcome: "committed", connectionClosed: false }); expect(release).not.toHaveBeenCalled();
    vi.restoreAllMocks(); expect(connect(file).pragma("user_version", { simple: true })).toBe(2);
  });
  it("keeps committed data after completion reporter failure", () => {
    const file = makeFile(); seed(file); const events: SqliteMigrationEvent[] = [];
    expect(() => openSqliteDatabase({ file, format, allowEmpty: false, onMigration: event => { events.push(event); if (event.kind === "completed") throw new Error("report failed"); } })).toThrow("cleanup-failed");
    expect(events.at(-1)).toMatchObject({ kind: "failed", outcome: "committed" }); expect(connect(file).pragma("user_version", { simple: true })).toBe(2);
  });
  it("keeps explicitly authored startup admission errors but safely wraps parser failures", () => {
    const file = makeFile(), business = new Error("Original execution is still running.");
    expect(() => openSqliteDatabase({ file, format, allowEmpty: true, onMigration: quiet, onReady: () => { throw business; } })).toThrow(business);
    let error: unknown;
    try { openSqliteDatabase({ file, format, allowEmpty: true, onMigration: quiet, onReady: () => { JSON.parse('{"secret":"prompt" broken}'); } }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SqliteAccessError); expect(JSON.stringify(serializeSqliteError(error))).not.toContain('"prompt"'); expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });
  it("identifies a baseline failure and rolls its partial DDL back", () => {
    const file = makeFile(), events: SqliteMigrationEvent[] = [];
    const bad: SqliteFormat = { ...format, baseline: { version: 1, create: db => { db.exec("CREATE TABLE partial(id INTEGER)"); throw new Error("baseline failed"); } } };
    let error: unknown;
    try { openSqliteDatabase({ file, format: bad, allowEmpty: true, onMigration: event => { events.push(event); } }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ context: { fromVersion: 0, toVersion: 2, stepVersion: 1 }, outcome: "rolled-back", connectionClosed: true });
    expect(events.at(-1)).toMatchObject({ kind: "failed", stepVersion: 1, outcome: "rolled-back" });
    const db = connect(file); expect(db.pragma("user_version", { simple: true })).toBe(0); expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
  });
  it("retains a failed conversion's step and close error without exposing stored text", () => {
    const file = makeFile(); seed(file); const close = Database.prototype.close, conversion = new SyntaxError("secret prompt payload");
    const bad: SqliteFormat = { ...format, migrations: [{ toVersion: 2, up: () => { throw conversion; } }] };
    vi.spyOn(Database.prototype, "close").mockImplementation(function(this: Database.Database) { connections.add(this); if (!this.readonly) throw new Error("closing failed"); return close.call(this); });
    let error: unknown; try { openSqliteDatabase({ file, format: bad, allowEmpty: false, onMigration: quiet }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: "migration-failed", context: { stepVersion: 2 }, connectionClosed: false, outcome: "rolled-back" }); expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(JSON.stringify(serializeSqliteError(error))).not.toContain("secret prompt payload");
  });
});

describe("manual SQLite migration transactions", () => {
  it("rejects nesting and asynchronous callback results", () => {
    const db = connect(":memory:");
    expect(() => runSqliteImmediate(db, () => Promise.resolve(1))).toThrow("must be synchronous"); expect(db.inTransaction).toBe(false);
    db.exec("BEGIN"); expect(() => runSqliteImmediate(db, () => 1)).toThrow("cannot nest"); db.exec("ROLLBACK");
  });
  it("preserves the original error together with a rollback failure", () => {
    const db = connect(":memory:"), primary = new Error("action failed"), rollback = new Error("rollback failed"), exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { if (sql === "ROLLBACK") throw rollback; return exec.call(this, sql); });
    try { runSqliteImmediate(db, () => { throw primary; }); expect.unreachable(); } catch (error) { expect((error as AggregateError).errors).toEqual([primary, rollback]); }
  });
});
