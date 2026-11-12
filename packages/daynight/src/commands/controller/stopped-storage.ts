import Database from "better-sqlite3";
import { closeSqliteDatabase, openSqliteDatabase, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { assertJournalMigrationAllowed, controllerJournalFormat } from "./journal-format.js";
import { inspectSqlite } from "../../platform/sqlite-format.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import { acquireControllerStoragePermit } from "./storage-lock.js";
import { controllerJournalWriteOptions } from "./storage-preparation.js";

/** Stopped settlement keeps its existing capacity allowance; new-writer admission belongs to recovery preparation. */
export const withStoppedControllerStorage = <T>(options: {
  journalPath: string; stateDirectory: string; ticket: ControllerLaunchTicket;
  assertOriginal(db: Database.Database): void;
}, action: (db: Database.Database) => T): T => {
  const { journalPath, stateDirectory, ticket } = options;
  const permit = acquireControllerStoragePermit(journalPath);
  let db: Database.Database | undefined, value: T | undefined;
  let failed = false, failure: unknown, outcome: SqliteOutcome = "not-started";
  try {
    db = new Database(journalPath, { readonly: true, fileMustExist: true });
    options.assertOriginal(db);
    closeSqliteDatabase(db, { file: journalPath, format: controllerJournalFormat }, "not-started");
    db = undefined;
    const write = controllerJournalWriteOptions(journalPath, permit, stateDirectory, ticket.executionId);
    db = openSqliteDatabase({ ...write, allowCreate: false,
      assertMigrationAllowed: (connection, source) => { options.assertOriginal(connection); write.assertMigrationAllowed(connection, source); },
      onReady: connection => {
        options.assertOriginal(connection);
        assertJournalMigrationAllowed(connection, inspectSqlite(connection, write.format));
      },
    });
    outcome = "committed";
    value = action(db);
  } catch (error) {
    failed = true; failure = error;
    outcome = error instanceof SqliteAccessError ? error.outcome : sqliteTransactionOutcome(error);
  }
  let cleanup: unknown, closed = db === undefined && (!(failure instanceof SqliteAccessError) || failure.connectionClosed);
  if (db !== undefined && !db.open) closed = true;
  if (db !== undefined && db.open) {
    try { closeSqliteDatabase(db, { file: journalPath, format: controllerJournalFormat }, outcome); closed = true; }
    catch (error) { cleanup = error; closed = !db.open; }
  }
  if (closed) {
    try { permit.release(); }
    catch (error) { cleanup = cleanup === undefined ? error : new AggregateError([cleanup, error], "Stopped storage shutdown and permit release failed."); }
  }
  if (cleanup !== undefined) throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file: journalPath, phase: "stopped-storage-release" }, {
    cause: failed ? new AggregateError([failure, cleanup], "Stopped storage operation and cleanup failed.") : cleanup,
    outcome, connectionClosed: closed,
  });
  if (failed) throw failure;
  return value!;
};
