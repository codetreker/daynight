import type Database from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { MaintenanceLockHeldError } from "../../platform/instance-lock.js";
import { closeSqliteDatabase, openSqliteDatabase, type SqliteDatabaseSource, type SqliteMigrationReporter } from "../../platform/sqlite-access.js";
import { canonicalId } from "../../api/parse.js";
import { SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { assertJournalMigrationAllowed, controllerJournalFormatForMigration, type JournalMigrationContext } from "./journal-format.js";
import { controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { validateWindowsStoredStopProof, type ControllerSnapshot } from "./lifecycle-store.js";
import { finalizePendingMigration, openPendingContent, reconcilePendingContent } from "./pending-content.js";
import { acquireControllerStoragePermit, assertControllerStoragePermit, isControllerStorageLockHeld, type ControllerStoragePermit } from "./storage-lock.js";
import { assertControllerStorageCapacity, isControllerStorageCapacityError } from "./storage-capacity.js";

export type { JournalMigrationContext } from "./journal-format.js";
export type ControllerStorageRequest = { journalFile: string; stateDirectory: string; deadline?: number } & (
  | { mode: "upgrade-only" }
  | { mode: "stopped-maintenance"; ticket: ControllerLaunchTicket }
  | { mode: "writer"; ticket: ControllerLaunchTicket }
);
export type ControllerStoragePreparation =
  | { kind: "prepared"; snapshot: ControllerSnapshot | null; legacyTimelineCleanupPending: boolean }
  | { kind: "waiting"; reason: "reader_busy" | "physical_capacity"; cause: Error };
export class ControllerStorageWaitingError extends Error {
  constructor(readonly reason: "lock_busy" | "reader_busy" | "physical_capacity", cause: Error) {
    super(`Controller storage preparation is waiting: ${reason}.`, { cause });
    this.name = "ControllerStorageWaitingError";
  }
}

class ControllerStorageAdmissionError extends Error {
  constructor(cause: unknown) { super("Controller storage admission failed.", { cause }); }
}
const storageTimeout = (deadline?: number): number => {
  if (deadline === undefined) return 5000;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new TypeError("Controller storage deadline must be a positive safe integer.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Controller storage preparation exceeded its deadline.");
  return Math.min(5000, remaining);
};

type ExecutionRow = { snapshot: string; ticket_hash: string; owner_pid: number | null };
const executionRow = (db: Database.Database): ExecutionRow | undefined => {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='execution' COLLATE NOCASE AND type IN ('table','view')").get() === undefined) return undefined;
  return db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as ExecutionRow | undefined;
};
const originalSnapshot = (row: ExecutionRow | undefined): ControllerSnapshot | null => {
  if (row === undefined) return null;
  const value: unknown = JSON.parse(row.snapshot);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("executionId" in value) || typeof value.executionId !== "string" || canonicalId(value.executionId) !== value.executionId || !("sessionId" in value) || typeof value.sessionId !== "string" || canonicalId(value.sessionId) !== value.sessionId) throw new Error("Controller storage execution or session identity is invalid.");
  return value as ControllerSnapshot;
};

export const controllerJournalStateDirectory = (file: string): string => {
  const execution = path.dirname(file), executions = path.dirname(execution), controller = path.dirname(executions);
  return path.basename(executions) === "executions" && path.basename(controller) === "controller" ? path.dirname(controller) : execution;
};

export const createControllerJournalMigrationContext = (db: Database.Database, permit: ControllerStoragePermit, stateDirectory: string, executionId?: string, deadline?: number): JournalMigrationContext => ({
  storagePermit: permit,
  assertReservedWrite: (additionalBytes: number): void => {
    assertControllerStoragePermit(permit, permit.journalFile);
    storageTimeout(deadline);
    const snapshot = originalSnapshot(executionRow(db));
    if (executionId !== undefined && snapshot !== null && snapshot.executionId !== executionId) throw new Error("Controller storage reservation belongs to another execution.");
    assertControllerStorageCapacity(permit.journalFile, db, stateDirectory, executionId === undefined ? snapshot?.executionId : executionId, additionalBytes, deadline);
    storageTimeout(deadline);
  },
});

export const controllerJournalWriteOptions = (file: string, permit: ControllerStoragePermit, stateDirectory: string, executionId?: string, deadline?: number) => {
  assertControllerStoragePermit(permit, file);
  return { file, format: controllerJournalFormatForMigration(db => createControllerJournalMigrationContext(db, permit, stateDirectory, executionId, deadline)), assertMigrationAllowed: assertJournalMigrationAllowed };
};

/** Current-schema reads remain lock-free; only actual upgrades request ownership. */
export const controllerJournalReadOptions = (file: SqliteDatabaseSource, existingPermit?: ControllerStoragePermit) => {
  let heldPermit = existingPermit;
  if (existingPermit !== undefined && typeof file === "string") assertControllerStoragePermit(existingPermit, file);
  return {
    file,
    format: controllerJournalFormatForMigration(db => {
      if (heldPermit === undefined) throw new Error("Controller journal migration requires its original storage permit and reserved-write context.");
      return createControllerJournalMigrationContext(db, heldPermit, controllerJournalStateDirectory(heldPermit.journalFile));
    }),
    assertMigrationAllowed: assertJournalMigrationAllowed,
    ...(typeof file !== "string" || existingPermit !== undefined ? {} : { acquireMaintenance: () => {
      let permit: ControllerStoragePermit;
      try { permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true }); }
      catch (cause) {
        if (isControllerStorageLockHeld(cause)) throw new MaintenanceLockHeldError(path.join(path.dirname(file), "storage.lock"), { cause });
        throw cause;
      }
      heldPermit = permit;
      return { owner: permit.owner, release: (): void => { permit.release(); heldPermit = undefined; } };
    } }),
  };
};

const assertOwnerStopped = (row: ExecutionRow): void => {
  if (row.owner_pid === null) return;
  try { process.kill(row.owner_pid, 0); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return;
    throw new Error("Controller storage owner state is unknown.", { cause });
  }
  throw new Error("The original controller journal writer is still running.");
};
const assertBinding = (snapshot: ControllerSnapshot, ticket: ControllerLaunchTicket): void => {
  if (snapshot === null || typeof snapshot !== "object" || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== ticket.testExecutionId) throw new Error("Controller storage belongs to another execution.");
};
const assertRole = (request: ControllerStorageRequest, row: ExecutionRow | undefined): ControllerSnapshot | null => {
  const snapshot = originalSnapshot(row);
  if (request.mode === "upgrade-only") { if (row !== undefined) assertOwnerStopped(row); return snapshot; }
  const ticket = parseLaunchTicket(request.ticket);
  if (row === undefined) {
    if (request.mode !== "writer" || ticket.executionGeneration !== "1") throw new Error("Controller storage requires the original first-generation ticket or stopped predecessor.");
    return null;
  }
  assertOwnerStopped(row);
  assertBinding(snapshot!, ticket);
  if (request.mode === "stopped-maintenance") {
    if (row.ticket_hash !== controllerPayloadHash(ticket) || snapshot!.executionGeneration !== ticket.executionGeneration || snapshot!.controllerInstanceId !== ticket.controllerInstanceId || snapshot!.lifecycle !== "stopped" || snapshot!.nativeStopped !== true || snapshot!.stoppedAt === null) throw new Error("Controller storage maintenance requires the original stopped generation.");
  } else if (snapshot!.lifecycle !== "stopped" || snapshot!.nativeStopped !== true || snapshot!.nativeSessionId === null || snapshot!.nativeSessionId !== ticket.resumeNativeSessionId || BigInt(snapshot!.executionGeneration) + 1n !== BigInt(ticket.executionGeneration) || row.ticket_hash === controllerPayloadHash(ticket)) throw new Error("Controller writer storage requires the exact stopped predecessor and new generation ticket.");
  if (process.platform === "win32") validateWindowsStoredStopProof(snapshot!, row.ticket_hash);
  return snapshot;
};

export const prepareControllerStorage = (request: ControllerStorageRequest, permit: ControllerStoragePermit, onMigration?: SqliteMigrationReporter): ControllerStoragePreparation => {
  assertControllerStoragePermit(permit, request.journalFile);
  if (!path.isAbsolute(request.stateDirectory)) throw new TypeError("Controller storage state directory must be absolute.");
  const options = controllerJournalWriteOptions(request.journalFile, permit, request.stateDirectory, request.mode === "upgrade-only" ? undefined : request.ticket.executionId, request.deadline);
  let db: Database.Database | undefined, outcome: SqliteOutcome = "not-started", failure: unknown;
  let snapshot: ControllerSnapshot | null = null;
  try {
    db = openSqliteDatabase({ ...options, allowCreate: request.mode === "writer", timeoutMs: storageTimeout(request.deadline), ...(onMigration === undefined ? {} : { onMigration }),
      assertMigrationAllowed: (database, source) => { assertJournalMigrationAllowed(database, source); assertRole(request, executionRow(database)); },
      onReady: database => {
        try {
        storageTimeout(request.deadline);
        assertControllerStoragePermit(permit, request.journalFile);
        snapshot = assertRole(request, executionRow(database));
        if (!database.memory) chmodSync(request.journalFile, 0o600);
        if (snapshot !== null || request.mode === "writer") {
          const sessionId = request.mode === "writer" ? request.ticket.sessionId : snapshot!.sessionId;
          if (snapshot !== null && !existsSync(`${request.journalFile}.pending-content/manifest.json`)) throw new Error("Pending archive source is missing.");
          const content = openPendingContent(request.journalFile, sessionId, database);
          if (snapshot === null && (content.hasRetainedEntries() || content.entries.size !== 0 || content.resources.size !== 0)) throw new Error("Pending archive source has no original controller execution.");
          reconcilePendingContent(database, content);
        }
        assertControllerStorageCapacity(request.journalFile, database, request.stateDirectory, snapshot?.executionId ?? (request.mode === "writer" ? request.ticket.executionId : undefined), 0, request.deadline);
        storageTimeout(request.deadline);
        } catch (cause) { throw new ControllerStorageAdmissionError(cause); }
      },
    });
    outcome = "committed";
    storageTimeout(request.deadline);
    const committedSnapshot = (() : ControllerSnapshot | null => snapshot)();
    if (committedSnapshot !== null) {
      const content = openPendingContent(request.journalFile, committedSnapshot.sessionId, db);
      finalizePendingMigration(db, content);
    }
    storageTimeout(request.deadline);
  } catch (error) { failure = error; if (outcome !== "committed") outcome = error instanceof SqliteAccessError ? error.outcome : "unknown"; }
  if (db !== undefined && db.open) try { closeSqliteDatabase(db, { file: request.journalFile, format: options.format }, outcome); }
  catch (close) {
    if (failure !== undefined) throw new SqliteAccessError("cleanup-failed", { database: options.format.name, file: request.journalFile, phase: "close" }, { cause: new AggregateError([failure, close], "Controller storage preparation and connection close failed."), outcome, connectionClosed: false });
    throw close;
  }
  if (failure !== undefined) {
    if (!(failure instanceof SqliteAccessError)) failure = new SqliteAccessError("migration-failed", { database: options.format.name, file: request.journalFile, phase: "storage-preparation" }, { cause: failure, outcome, connectionClosed: db === undefined || !db.open });
    const capacityCause = (cause: unknown): Error | undefined => {
      if (isControllerStorageCapacityError(cause)) return cause;
      if (cause instanceof AggregateError || cause instanceof SqliteAccessError && cause.kind === "cleanup-failed") return undefined;
      return cause instanceof Error ? capacityCause(cause.cause) : undefined;
    };
    if (capacityCause(failure) !== undefined && failure instanceof Error) return { kind: "waiting", reason: "physical_capacity", cause: failure };
    throw failure;
  }
  return { kind: "prepared", snapshot, legacyTimelineCleanupPending: false };
};
