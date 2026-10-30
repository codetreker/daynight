import type Database from "better-sqlite3";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import type { SqliteFormat, SqliteSource } from "../../platform/sqlite-format.js";

const schema = "CREATE TABLE leases (native_key TEXT PRIMARY KEY, nonce TEXT NOT NULL, source_session_id TEXT NOT NULL, launcher_proof TEXT NOT NULL, created_at TEXT NOT NULL)";
const normalized = (sql: string): string => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
const validate = (db: Database.Database): undefined => {
  const rows = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string; type: string; sql: string | null }[];
  if (rows.length !== 1 || rows[0]!.name !== "leases" || rows[0]!.type !== "table" || rows[0]!.sql === null || normalized(rows[0]!.sql) !== normalized(schema)) throw new Error("Native resume leases do not match the supported schema.");
};
export const nativeResumeLeaseFormat: SqliteFormat = {
  name: "native-resume-leases",
  baseline: { version: 1, create: (db) => { db.exec(schema); } },
  unversioned: { validate, adopt: () => {} },
  migrations: [],
  validateVersioned: (db) => { validate(db); },
};
export const assertResumeLeaseMigrationAllowed = (db: Database.Database, source: SqliteSource): undefined => {
  if (source.kind === "empty") return;
  if (db.prepare("SELECT 1 FROM leases LIMIT 1").get() !== undefined) throw new SqliteAccessError("upgrade-blocked", { database: nativeResumeLeaseFormat.name, phase: "lease-admission", fromVersion: source.version, toVersion: 1 });
};
