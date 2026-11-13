import type Database from "better-sqlite3";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { currentSqliteVersion, type SqliteFormat, type SqliteSource } from "../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject, type SqliteSchemaStep } from "../../platform/sqlite-sql.js";
import { canonicalId } from "../../api/parse.js";
import { migratePendingContent, migratePendingEntryPointers } from "./pending-content.js";
import { assertControllerStoragePermit, type ControllerStoragePermit } from "./storage-lock.js";

const steps = loadSqliteSequence(new URL("./sqlite/journal/", import.meta.url));
const [baseline, ...upgrades] = steps;

// These shipped definitions contain no case- or whitespace-sensitive string
// literals; normalize only their finite CREATE/ALTER layouts.
const normalized = (sql: string): string => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
const schemaValidator = (sequence: readonly SqliteSchemaStep[]) => {
  const schemas = sqliteSchemaSnapshots(sequence);
  return (db: Database.Database, version: number): undefined => {
    const expected = schemas.get(version);
    if (expected === undefined) throw new Error("Unsupported Controller journal schema version.");
    const actual = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
    if (actual.length !== expected.length || actual.some((row, index) => row.type !== expected[index]!.type || row.name !== expected[index]!.name || row.sql === null || expected[index]!.sql === null || normalized(row.sql) !== normalized(expected[index]!.sql!))) throw new Error("Controller journal does not match its declared schema version.");
  };
};
const validateVersioned = schemaValidator(steps);

export type JournalMigrationContext = {
  readonly storagePermit: ControllerStoragePermit;
  assertReservedWrite(additionalBytes: number): void;
  /** A migration may reserve its full retained-source peak before exporting files. */
  assertPendingWrite?(additionalBytes: number): void;
};

export type JournalSchemaExtension = {
  readonly schema: SqliteSchemaStep;
  readonly migrate: (db: Database.Database, source: SqliteSource, context: JournalMigrationContext) => undefined;
};

/** The numbered journal and isolated components share one complete schema validator. */
export const controllerJournalFormatWithExtension = (context: (db: Database.Database) => JournalMigrationContext, extension?: JournalSchemaExtension): SqliteFormat => {
  const assertWrite = (db: Database.Database, additionalBytes: number): void => {
    const permission = context(db);
    assertControllerStoragePermit(permission.storagePermit, permission.storagePermit.journalFile);
    if (!db.memory && db.name !== permission.storagePermit.journalFile) throw new Error("Controller journal migration permit belongs to another database.");
    permission.assertReservedWrite(additionalBytes);
  };
  return {
    name: "controller-journal",
    baseline: { version: baseline.version, create: (db) => { assertWrite(db, Buffer.byteLength(baseline.sql) + 16384); db.exec(baseline.sql); } },
    migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database, source: SqliteSource): undefined => {
      assertWrite(db, Buffer.byteLength(step.sql) + 16384);
      if (step.version !== 6 && step.version !== 8) { db.exec(step.sql); return; }
      const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined;
      if (row === undefined) {
        if (step.version === 6 ? db.prepare("SELECT 1 FROM projection LIMIT 1").get() !== undefined || db.prepare("SELECT 1 FROM resources LIMIT 1").get() !== undefined : db.prepare("SELECT 1 FROM content_index LIMIT 1").get() !== undefined) throw new Error("Legacy archive content has no original controller execution.");
        db.exec(step.sql); return;
      }
      const snapshot = JSON.parse(row.snapshot) as { sessionId?: unknown };
      if (typeof snapshot.sessionId !== "string" || canonicalId(snapshot.sessionId) !== snapshot.sessionId) throw new Error("Legacy journal session identity is invalid.");
      // Files survive an enclosing migration rollback; SQL sources disappear only
      // after their complete pending archive has reached durable storage.
      if (step.version === 8) { migratePendingEntryPointers(db, snapshot.sessionId, step.sql, context(db).assertPendingWrite); return; }
      migratePendingContent(db, snapshot.sessionId, step.sql, context(db).assertPendingWrite);
      // Version 1 has no durable projection, and its acknowledged outbox may have
      // discarded history. Intermediate DDL cannot establish that source as complete.
      if (source.kind === "outdated" && source.version === 1) db.exec("UPDATE execution SET archive_incomplete=1 WHERE id=1");
    } })).concat(extension === undefined ? [] : [{ toVersion: extension.schema.version, up: (db: Database.Database, source: SqliteSource): undefined => {
      assertWrite(db, Buffer.byteLength(extension.schema.sql) + 16384);
      return extension.migrate(db, source, context(db));
    } }]),
    validateVersioned: extension === undefined ? validateVersioned : schemaValidator([...steps, extension.schema]),
  };
};

export const controllerJournalFormatForMigration = (context: (db: Database.Database) => JournalMigrationContext): SqliteFormat => controllerJournalFormatWithExtension(context);

export const controllerJournalFormat = controllerJournalFormatForMigration(() => { throw new Error("Controller journal migration requires its original storage permit and reserved-write context."); });

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
