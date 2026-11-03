import type Database from "better-sqlite3";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { currentSqliteVersion, type SqliteFormat, type SqliteSource } from "../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";
import { canonicalId } from "../../api/parse.js";
import { migratePendingContent, openPendingContent } from "./pending-content.js";

const steps = loadSqliteSequence(new URL("./sqlite/journal/", import.meta.url));
const [baseline, ...upgrades] = steps;
const schemas = sqliteSchemaSnapshots(steps);
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
  baseline: { version: baseline.version, create: (db) => { db.exec(baseline.sql); } },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => {
    if (step.version !== 6) { db.exec(step.sql); return; }
    const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined;
    if (row === undefined) {
      if (db.prepare("SELECT 1 FROM projection LIMIT 1").get() !== undefined || db.prepare("SELECT 1 FROM resources LIMIT 1").get() !== undefined) throw new Error("Legacy archive content has no original controller execution.");
      db.exec(step.sql); return;
    }
    const snapshot = JSON.parse(row.snapshot) as { sessionId?: unknown };
    if (typeof snapshot.sessionId !== "string" || canonicalId(snapshot.sessionId) !== snapshot.sessionId) throw new Error("Legacy journal session identity is invalid.");
    // Files survive an enclosing migration rollback; SQL sources disappear only
    // after their complete pending archive has reached durable storage.
    migratePendingContent(db, openPendingContent(db.name, snapshot.sessionId), step.sql);
  } })),
  validateVersioned,
};

export const assertJournalMigrationAllowed = (db: Database.Database, source: SqliteSource): undefined => {
  if (source.kind === "empty") return;
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table','view') AND name='execution' COLLATE NOCASE").get() === undefined) return;
  const owner = db.prepare("SELECT owner_pid FROM execution WHERE id=1").get() as { owner_pid: number | null } | undefined;
  if (owner === undefined || owner.owner_pid === null) return;
  try { process.kill(owner.owner_pid, 0); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return;
    throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion: currentSqliteVersion(controllerJournalFormat) }, { cause });
  }
  throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion: currentSqliteVersion(controllerJournalFormat) });
};
