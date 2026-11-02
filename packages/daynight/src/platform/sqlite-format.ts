import type Database from "better-sqlite3";
import { SqliteAccessError } from "./sqlite-error.js";

export type SqliteMigration = { readonly toVersion: number; readonly up: (db: Database.Database) => undefined };
export type SqliteFormat = {
  readonly name: string;
  readonly baseline: { readonly version: number; readonly create: (db: Database.Database) => undefined };
  readonly migrations: readonly SqliteMigration[];
  readonly validateVersioned: (db: Database.Database, version: number) => undefined;
};
export type SqliteSource = { readonly kind: "empty" | "unversioned"; readonly version: 0 } | { readonly kind: "outdated" | "current"; readonly version: number };
export type SqliteTransition = { readonly fromVersion: number; readonly toVersion: number; readonly initialized: boolean; readonly reset: boolean };

const validVersion = (value: number): boolean => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
export const currentSqliteVersion = (format: SqliteFormat): number => {
  if (!validVersion(format.baseline.version)) throw new TypeError("SQLite baseline must be a positive signed 32-bit integer.");
  let current = format.baseline.version;
  for (const migration of format.migrations) {
    if (!validVersion(migration.toVersion) || migration.toVersion !== current + 1) throw new TypeError("SQLite migration versions must be consecutive after the baseline.");
    current = migration.toVersion;
  }
  return current;
};
const versionOf = (db: Database.Database): number => db.pragma("user_version", { simple: true }) as number;
const invalid = (format: SqliteFormat, version: number, cause?: unknown): SqliteAccessError => new SqliteAccessError("invalid-format", { database: format.name, phase: "inspect", fromVersion: version, toVersion: currentSqliteVersion(format) }, cause === undefined ? {} : { cause });
export const inspectSqlite = (db: Database.Database, format: SqliteFormat): SqliteSource => {
  const target = currentSqliteVersion(format), version = versionOf(db);
  if (!Number.isInteger(version) || version < 0 || version > target || version !== 0 && version < format.baseline.version) throw new SqliteAccessError("unsupported-version", { database: format.name, phase: "inspect", fromVersion: version, toVersion: target });
  try {
    if (version === 0) {
      const objects = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
      return { kind: objects.length === 0 ? "empty" : "unversioned", version: 0 };
    }
    format.validateVersioned(db, version);
    return { kind: version === target ? "current" : "outdated", version };
  } catch (cause) {
    if (cause instanceof SqliteAccessError) throw cause;
    throw invalid(format, version, cause);
  }
};
export const assertCurrentSqlite = (db: Database.Database, format: SqliteFormat): undefined => {
  if (!db.inTransaction) throw new Error("SQLite format assertion requires a transaction.");
  const version = versionOf(db), target = currentSqliteVersion(format);
  if (version !== target) throw new SqliteAccessError("unsupported-version", { database: format.name, phase: "assert-current", fromVersion: version, toVersion: target });
};
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const resetUnversionedSqlite = (db: Database.Database): undefined => {
  if (db.pragma("foreign_keys", { simple: true }) !== 0) throw new Error("SQLite unversioned reset requires foreign_keys=OFF before beginning the transaction.");
  const objects = db.prepare("SELECT name, type FROM main.sqlite_schema WHERE type IN ('trigger', 'view') AND name NOT GLOB 'sqlite_*' ORDER BY type, name").all() as { name: string; type: "trigger" | "view" }[];
  for (const object of objects) db.exec(`DROP ${object.type.toUpperCase()} main.${quoteIdentifier(object.name)}`);
  const tables = (db.pragma("main.table_list") as { schema: string; name: string; type: string }[])
    .filter(table => table.schema === "main" && !table.name.startsWith("sqlite_") && (table.type === "virtual" || table.type === "table"))
    .sort((left, right) => Number(right.type === "virtual") - Number(left.type === "virtual"));
  // Virtual tables own their shadow tables; dropping a shadow table independently can corrupt them.
  for (const table of tables) db.exec(`DROP TABLE main.${quoteIdentifier(table.name)}`);
};
export const upgradeSqlite = (db: Database.Database, format: SqliteFormat): SqliteTransition | null => {
  if (!db.inTransaction) throw new Error("SQLite migration requires an immediate transaction.");
  const source = inspectSqlite(db, format);
  if (source.kind === "current") return null;
  let version = source.version;
  if (source.kind === "empty" || source.kind === "unversioned") {
    try {
      if (source.kind === "unversioned") resetUnversionedSqlite(db);
      format.baseline.create(db);
      format.validateVersioned(db, format.baseline.version);
      db.pragma(`user_version = ${format.baseline.version}`);
      version = format.baseline.version;
    } catch (cause) {
      throw new SqliteAccessError("migration-failed", { database: format.name, phase: source.kind === "empty" ? "initialize" : "reset", fromVersion: source.version, toVersion: currentSqliteVersion(format), stepVersion: format.baseline.version }, { cause, outcome: "unknown" });
    }
  }
  for (const migration of format.migrations) {
    if (migration.toVersion <= version) continue;
    try {
      migration.up(db);
      format.validateVersioned(db, migration.toVersion);
      db.pragma(`user_version = ${migration.toVersion}`);
      version = migration.toVersion;
    } catch (cause) {
      throw new SqliteAccessError("migration-failed", { database: format.name, phase: "migrate", fromVersion: source.version, toVersion: currentSqliteVersion(format), stepVersion: migration.toVersion }, { cause, outcome: "unknown" });
    }
  }
  format.validateVersioned(db, version);
  return { fromVersion: source.version, toVersion: version, initialized: source.kind === "empty", reset: source.kind === "unversioned" };
};
