import type Database from "better-sqlite3";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { currentSqliteVersion, type SqliteFormat, type SqliteSource } from "../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";

const steps = loadSqliteSequence(new URL("./sqlite/resume-lease/", import.meta.url));
const [baseline, ...upgrades] = steps;
const schemas = sqliteSchemaSnapshots(steps);
const normalized = (sql: string): string => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
const validate = (db: Database.Database, expected: readonly SqliteSchemaObject[]): undefined => {
  const rows = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (rows.length !== expected.length || rows.some((row, index) => {
    const known = expected[index]!;
    return row.name !== known.name || row.type !== known.type || row.sql === null || known.sql === null || normalized(row.sql) !== normalized(known.sql);
  })) throw new Error("Native resume leases do not match the supported schema.");
};
export const nativeResumeLeaseFormat: SqliteFormat = {
  name: "native-resume-leases",
  baseline: { version: baseline.version, create: (db) => { db.exec(baseline.sql); } },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => { db.exec(step.sql); } })),
  validateVersioned: (db, version) => {
    const expected = schemas.get(version);
    if (expected === undefined) throw new Error("Unsupported native resume leases SQLite version.");
    validate(db, expected);
  },
};
export const assertResumeLeaseMigrationAllowed = (db: Database.Database, source: SqliteSource): undefined => {
  if (source.kind === "empty") return;
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table','view') AND name='leases' COLLATE NOCASE").get() === undefined) return;
  if (db.prepare("SELECT 1 FROM leases LIMIT 1").get() !== undefined) throw new SqliteAccessError("upgrade-blocked", { database: nativeResumeLeaseFormat.name, phase: "lease-admission", fromVersion: source.version, toVersion: currentSqliteVersion(nativeResumeLeaseFormat) });
};
