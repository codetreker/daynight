import { sqliteDisplayFilename } from "../../platform/sqlite-filename.js";
import type Database from "better-sqlite3";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { currentSqliteVersion, inspectSqlite, type SqliteFormat, type SqliteSource } from "../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";
import { migratePendingContent, migratePendingEntryPointers } from "./pending-content.js";
import { assertNoOrphanTimelineSource, importControllerTimeline } from "./content/migration.js";
import { assertControllerStoragePermit, type ControllerStoragePermit } from "./storage-lock.js";
import { initializeOutboxAccounting } from "./outbox-migration.js";
import { readControllerOutboxByteLength } from "./outbox-store.js";
import { migrateDirectCaptureState } from "./media/capture-migration.js";

const steps = loadSqliteSequence(new URL("./sqlite/journal/", import.meta.url));
const [baseline, ...upgrades] = steps;

// These shipped definitions contain no case- or whitespace-sensitive string
// literals; normalize only their finite CREATE/ALTER layouts.
const normalized = (sql: string): string => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
const schemas = sqliteSchemaSnapshots(steps);
const validateVersioned = (db: Database.Database, version: number): undefined => {
  const expected = schemas.get(version);
  if (expected === undefined) throw new Error("Unsupported Controller journal schema version.");
  const actual = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (actual.length !== expected.length || actual.some((row, index) => row.type !== expected[index]!.type || row.name !== expected[index]!.name || row.sql === null || expected[index]!.sql === null || normalized(row.sql) !== normalized(expected[index]!.sql!))) throw new Error("Controller journal does not match its declared schema version.");
  if (version >= 11) readControllerOutboxByteLength(db);
};

export type JournalMigrationContext = {
  readonly storagePermit: ControllerStoragePermit;
};

export const controllerJournalFormatForMigration = (context: (db: Database.Database) => JournalMigrationContext): SqliteFormat => {
  const assertWrite = (db: Database.Database): void => {
    const permission = context(db);
    assertControllerStoragePermit(permission.storagePermit, permission.storagePermit.journalFile);
    if (!db.memory && sqliteDisplayFilename(db.name) !== permission.storagePermit.journalFile) throw new Error("Controller journal migration permit belongs to another database.");
  };
  return {
    name: "controller-journal",
    baseline: { version: baseline.version, create: (db) => { assertNoOrphanTimelineSource(sqliteDisplayFilename(db.name)); assertWrite(db); db.exec(baseline.sql); } },
    migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database, source: SqliteSource): undefined => {
      assertWrite(db);
      if (step.version === 10) return importControllerTimeline(db, context(db), step.sql);
      if (step.version === 11) return initializeOutboxAccounting(db, step.sql);
      if (step.version === 12) return migrateDirectCaptureState(db, step.sql);
      if (step.version !== 6 && step.version !== 8) { db.exec(step.sql); return; }
      const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined;
      let sessionId: string | undefined;
      if (row !== undefined) {
        let snapshot: unknown;
        try { snapshot = JSON.parse(row.snapshot); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        if (snapshot !== null && typeof snapshot === "object" && "sessionId" in snapshot && typeof snapshot.sessionId === "string") sessionId = snapshot.sessionId;
      }
      if (step.version === 8) { migratePendingEntryPointers(db, sessionId, step.sql, context(db).storagePermit); return; }
      migratePendingContent(db, sessionId, step.sql, context(db).storagePermit);
      // Version 1 has no durable projection, and its acknowledged outbox may have
      // discarded history. Intermediate DDL cannot establish that source as complete.
      if (source.kind === "outdated" && source.version === 1) db.exec("UPDATE execution SET archive_incomplete=1 WHERE id=1");
    } })),
    validateVersioned,
  };
};

export const controllerJournalFormat = controllerJournalFormatForMigration(() => { throw new Error("Controller journal migration requires its original storage permit."); });

/** Protected copies, retained inventories and exited-launch observations can read shipped v16 and v17 data without mutation. */
export const inspectReadCompatibleControllerJournal = (db: Database.Database): SqliteSource => {
  const source = inspectSqlite(db, controllerJournalFormat);
  if (source.kind !== "current" && !(source.kind === "outdated" && (source.version === 16 || source.version === 17))) throw new Error("Controller journal is not a supported read-only format.");
  return source;
};

export const assertJournalMigrationAllowed = (db: Database.Database, source: SqliteSource, toVersion = currentSqliteVersion(controllerJournalFormat)): undefined => {
  if (source.kind === "empty") return;
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table','view') AND name='execution' COLLATE NOCASE").get() === undefined) return;
  const owner = db.prepare("SELECT owner_pid FROM execution WHERE id=1").get() as { owner_pid: number | null } | undefined;
  if (owner === undefined || owner.owner_pid === null) return;
  try { process.kill(owner.owner_pid, 0); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return;
    throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion }, { cause });
  }
  throw new SqliteAccessError("upgrade-blocked", { database: controllerJournalFormat.name, phase: "owner-admission", fromVersion: source.version, toVersion });
};
