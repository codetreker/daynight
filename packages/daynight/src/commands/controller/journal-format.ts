import type Database from "better-sqlite3";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import type { SqliteFormat, SqliteSource } from "../../platform/sqlite-format.js";
import { loadSqliteSql, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";

const baselineSql = loadSqliteSql(new URL("./sqlite/journal/baseline-1.sql", import.meta.url));
const upgrades = [
  { version: 2, sql: loadSqliteSql(new URL("./sqlite/journal/upgrade-2.sql", import.meta.url)) },
  { version: 3, sql: loadSqliteSql(new URL("./sqlite/journal/upgrade-3.sql", import.meta.url)) },
  { version: 4, sql: loadSqliteSql(new URL("./sqlite/journal/upgrade-4.sql", import.meta.url)) },
  { version: 5, sql: loadSqliteSql(new URL("./sqlite/journal/upgrade-5.sql", import.meta.url)) },
];
const schemas = sqliteSchemaSnapshots([{ version: 1, sql: baselineSql }, ...upgrades]);
// These shipped definitions contain no string literals; whitespace and case do
// not distinguish their finite CREATE/ALTER layouts.
const normalized = (sql: string): string => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
const validateVersioned = (db: Database.Database, version: number): undefined => {
  const expected = schemas.get(version);
  if (expected === undefined) throw new Error("Unsupported Controller journal schema version.");
  const actual = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (actual.length !== expected.length || actual.some((row, index) => row.type !== expected[index]!.type || row.name !== expected[index]!.name || row.sql === null || expected[index]!.sql === null || normalized(row.sql) !== normalized(expected[index]!.sql!))) throw new Error("Controller journal does not match its declared schema version.");
};

export const controllerJournalFormat: SqliteFormat = {
  name: "controller-journal",
  baseline: { version: 1, create: (db) => { db.exec(baselineSql); } },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => { db.exec(step.sql); } })),
  validateVersioned,
};

export const assertJournalMigrationAllowed = (db: Database.Database, source: SqliteSource): undefined => {
  if (source.kind === "empty") return;
  const owner = db.prepare("SELECT owner_pid FROM execution WHERE id=1").get() as { owner_pid: number | null } | undefined;
  if (owner === undefined || owner.owner_pid === null) return;
  try { process.kill(owner.owner_pid, 0); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return;
    throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion: 5 }, { cause });
  }
  throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion: 5 });
};
