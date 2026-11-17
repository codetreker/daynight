import Database from "better-sqlite3";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { serializeSqliteError, SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { assertJournalMigrationAllowed, controllerJournalFormat } from "./journal-format.js";
import { assertCurrentSqlite, currentSqliteVersion, inspectSqlite } from "../../platform/sqlite-format.js";
import { randomUUID } from "node:crypto";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import { acquireControllerStoragePermit } from "./storage-lock.js";
import { assertControllerStorageRole, controllerStorageExecutionRow, controllerTimelineCleanupPending, controllerJournalWriteOptions, observeControllerStorage, reportControllerStorageEvent, ControllerStorageWaitingError, type ControllerStorageObservation } from "./storage-preparation.js";
import { maintainControllerTimeline } from "./content/maintenance.js";
import { openTimelineStore } from "./content/timeline-store.js";

/** Stopped settlement holds the storage permit without admitting a replacement writer. */
export const withStoppedControllerStorage = <T>(options: {
  journalPath: string; ticket: ControllerLaunchTicket;
  assertOriginal(db: Database.Database): void;
}, action: (db: Database.Database) => T): T => {
  const { journalPath, ticket } = options;
  const permit = acquireControllerStoragePermit(journalPath, undefined, { fileMustExist: true });
  let db: Database.Database | undefined, value: T | undefined, sourceVersion: number | undefined, admittedVersion: number | undefined;
  let failed = false, failure: unknown, outcome: SqliteOutcome = "not-started", admitted = false;
  let phase: "read" | "open" | "admission" | "operation" = "read";
  const observation: ControllerStorageObservation = { role: "stopped-maintenance", roleResult: "pending" }, started = Date.now(), migrationId = randomUUID();
  try {
    db = new Database(journalPath, { readonly: true, fileMustExist: true });
    sourceVersion = Number(db.pragma("user_version", { simple: true }));
    observeControllerStorage(observation, db);
    closeSqliteDatabase(db, { file: journalPath, format: controllerJournalFormat }, "not-started");
    db = undefined;
    const write = controllerJournalWriteOptions(journalPath, permit);
    phase = "open";
    db = openSqliteDatabase({ ...write, allowCreate: false });
    phase = "admission";
    admittedVersion = Number(db.pragma("user_version", { simple: true }));
    runSqliteImmediate(db, () => {
      assertCurrentSqlite(db!, write.format);
      options.assertOriginal(db!); observeControllerStorage(observation, db!);
      assertJournalMigrationAllowed(db!, inspectSqlite(db!, write.format));
      assertControllerStorageRole({ journalFile: journalPath, mode: "stopped-maintenance", ticket }, controllerStorageExecutionRow(db!));
    });
    outcome = "committed"; phase = "operation";
    if (controllerTimelineCleanupPending(db)) {
      const preparation = maintainControllerTimeline({ db, request: { journalFile: journalPath, mode: "stopped-maintenance", ticket }, storagePermit: permit });
      if (preparation.kind === "waiting") throw new ControllerStorageWaitingError(preparation.reason, preparation.cause);
    }
    db.transaction(() => {
      options.assertOriginal(db!);
      openTimelineStore(db!, { assertWrite: () => { throw new Error("Stopped storage admission is read-only."); } }).totals();
    }).deferred();
    admitted = true; observation.roleResult = "admitted";
    reportControllerStorageEvent({ migrationId, database: controllerJournalFormat.name, file: journalPath, kind: "completed", phase: "storage-admission", fromVersion: admittedVersion, toVersion: currentSqliteVersion(controllerJournalFormat), durationMs: Date.now() - started, outcome: "committed", storage: { admission: "settlement" } }, observation);
    value = action(db);
  } catch (error) {
    failed = true; failure = error;
    outcome = phase === "admission" ? sqliteTransactionOutcome(error) : error instanceof SqliteAccessError ? error.outcome : sqliteTransactionOutcome(error);
    if (!admitted && sourceVersion !== undefined) {
      observation.roleResult = error instanceof ControllerStorageWaitingError ? "waiting" : "rejected";
      reportControllerStorageEvent({ migrationId, database: controllerJournalFormat.name, file: journalPath, kind: "failed", phase: "storage-admission", fromVersion: admittedVersion ?? sourceVersion, toVersion: currentSqliteVersion(controllerJournalFormat), durationMs: Date.now() - started, outcome, error: serializeSqliteError(error) }, observation);
    }
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
  if (failed) {
    if (failure instanceof SqliteAccessError) throw new SqliteAccessError(failure.kind, failure.context, { cause: failure, outcome, connectionClosed: closed });
    if (failure instanceof Database.SqliteError || failure instanceof SyntaxError || failure instanceof AggregateError) throw new SqliteAccessError("operation-failed", { database: controllerJournalFormat.name, file: journalPath, phase: "stopped-storage" }, { cause: failure, outcome, connectionClosed: closed });
    throw failure;
  }
  return value!;
};
