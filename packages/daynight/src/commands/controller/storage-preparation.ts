import type Database from "better-sqlite3";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { MaintenanceLockHeldError } from "../../platform/instance-lock.js";
import { closeSqliteDatabase, openSqliteDatabase, readSqliteDatabase, reportSqliteMigrationEvent, sqliteTransactionOutcome, type SqliteDatabaseSource, type SqliteMigrationEvent, type SqliteMigrationReporter } from "../../platform/sqlite-access.js";
import { canonicalId } from "../../api/parse.js";
import { serializeSqliteError, SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { assertJournalMigrationAllowed, controllerJournalFormat, controllerJournalFormatForMigration, type JournalMigrationContext } from "./journal-format.js";
import { controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { validateWindowsStoredStopProof, type ControllerSnapshot } from "./lifecycle-store.js";
import { assertNoOrphanTimelineSource } from "./content/migration.js";
import { createTimelineMaintenanceReservation, maintainControllerTimeline, type TimelineMaintenanceReservation } from "./content/maintenance.js";
import { openTimelineStore } from "./content/timeline-store.js";
import { acquireControllerStoragePermit, assertControllerStoragePermit, isControllerStorageLockHeld, type ControllerStoragePermit } from "./storage-lock.js";
import { isControllerStorageCapacityError } from "./storage-capacity.js";
import { controllerJournalPhysicalBytes } from "./media/metadata-budget.js";

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

export type ControllerStorageExecutionRow = { snapshot: string; ticket_hash: string; owner_pid: number | null };
export const controllerStorageExecutionRow = (db: Database.Database): ControllerStorageExecutionRow | undefined => {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='execution' COLLATE NOCASE AND type IN ('table','view')").get() === undefined) return undefined;
  return db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as ControllerStorageExecutionRow | undefined;
};
const originalSnapshot = (row: ControllerStorageExecutionRow | undefined): ControllerSnapshot | null => {
  if (row === undefined) return null;
  const value: unknown = JSON.parse(row.snapshot);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("executionId" in value) || typeof value.executionId !== "string" || canonicalId(value.executionId) !== value.executionId || !("sessionId" in value) || typeof value.sessionId !== "string" || canonicalId(value.sessionId) !== value.sessionId) throw new Error("Controller storage execution or session identity is invalid.");
  return value as ControllerSnapshot;
};

type StorageMetrics = Record<string, number | string | boolean>;
export type ControllerStorageObservation = {
  db?: Database.Database;
  identity?: StorageMetrics;
  role: ControllerStorageRequest["mode"];
  roleResult: "pending" | "admitted" | "rejected" | "waiting";
};
const warn = (message: string, cause: unknown): void => { process.emitWarning(`${message} ${JSON.stringify(serializeSqliteError(cause))}`); };

/** Retain only validated correlation scalars when the actual connection becomes available. */
export const observeControllerStorage = (observation: ControllerStorageObservation, db: Database.Database, freshTicket?: ControllerLaunchTicket): void => {
  observation.db = db;
  try {
    const row = controllerStorageExecutionRow(db), value = row === undefined ? freshTicket : JSON.parse(row.snapshot) as Record<string, unknown>;
    if (value === undefined) { delete observation.identity; return; }
    const identity: StorageMetrics = {};
    for (const key of ["executionId", "sessionId", "claimId", "testExecutionId"] as const) {
      const id = value[key];
      if (typeof id === "string" && canonicalId(id) === id) identity[key] = id;
    }
    const generation = value.executionGeneration;
    if (typeof generation === "string" && /^[1-9][0-9]{0,18}$/.test(generation) && BigInt(generation) <= 9223372036854775807n) identity.generation = generation;
    observation.identity = identity;
  } catch (cause) { warn("Controller storage identity statistics failed.", cause); }
};

const physicalStorageMetrics = (db: Database.Database, metrics: StorageMetrics): void => {
  if (!db.memory) {
    Object.assign(metrics, controllerJournalPhysicalBytes(db.name, db));
    let oldFileCount = 0, oldFileBytes = 0;
    for (const kind of ["entries", "timeline", "legacy-sql"] as const) {
      const directory = path.join(`${db.name}.pending-content`, kind);
      let stat;
      try { stat = lstatSync(directory); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Controller timeline statistics require an ordinary source directory.");
      const recognized = kind === "entries" ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/ : kind === "timeline" ? /^[a-f0-9]{64}\.json$/ : /^[1-9][0-9]*\.timeline\.json$/;
      for (const name of readdirSync(directory).filter(name => recognized.test(name))) {
        const file = lstatSync(path.join(directory, name));
        if (!file.isFile() || file.isSymbolicLink()) throw new Error("Controller timeline statistics require regular source files.");
        oldFileCount++; oldFileBytes += file.size;
      }
    }
    Object.assign(metrics, { oldFileCount, oldFileBytes });
  }
  if (db.open && !db.inTransaction) {
    const pageSize = Number(db.pragma("page_size", { simple: true })), freePageCount = Number(db.pragma("freelist_count", { simple: true }));
    Object.assign(metrics, { pageCount: Number(db.pragma("page_count", { simple: true })), pageSize, freePageCount, freePageBytes: freePageCount * pageSize });
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='timeline_totals' AND type='table'").get() !== undefined) {
      const row = db.prepare("SELECT entry_count,byte_length FROM timeline_totals WHERE id=1").get() as { entry_count: number; byte_length: number } | undefined;
      if (row === undefined) throw new Error("Controller timeline statistics are missing.");
      if (![row.entry_count, row.byte_length].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Controller timeline statistics are invalid.");
      Object.assign(metrics, { entryCount: row.entry_count, byteLength: row.byte_length, timelineBytes: 14 + row.byte_length + Math.max(row.entry_count - 1, 0) });
    }
  }
  for (const value of Object.values(metrics)) if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Controller storage statistics are invalid.");
};

/** Statistics and reporting never replace the actual storage operation's result. */
export const reportControllerStorageEvent = (event: SqliteMigrationEvent, observation: ControllerStorageObservation, reporter?: SqliteMigrationReporter): undefined => {
  const physical: StorageMetrics = {};
  try { if (observation.db !== undefined) physicalStorageMetrics(observation.db, physical); }
  catch (cause) { warn("Controller storage physical statistics failed.", cause); }
  for (const [key, value] of Object.entries(physical)) if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) delete physical[key];
  const reported = { ...event, storage: { ...physical, ...observation.identity, ...event.storage, role: observation.role, roleResult: observation.roleResult } };
  try { (reporter ?? reportSqliteMigrationEvent)(reported); }
  catch (cause) { warn("Controller storage reporting failed.", cause); }
};
const importReporter = (observation: ControllerStorageObservation, reporter?: SqliteMigrationReporter, freshTicket?: ControllerLaunchTicket): SqliteMigrationReporter => event => {
  if (event.kind === "completed" && observation.db?.open) observeControllerStorage(observation, observation.db, freshTicket);
  return reportControllerStorageEvent({ ...event, phase: "timeline-import", storage: { ...event.storage, sqlitePhase: event.phase } }, observation, reporter);
};

export const controllerJournalStateDirectory = (file: string): string => {
  const execution = path.dirname(file), executions = path.dirname(execution), controller = path.dirname(executions);
  return path.basename(executions) === "executions" && path.basename(controller) === "controller" ? path.dirname(controller) : execution;
};

export const createControllerJournalMigrationContext = (db: Database.Database, permit: ControllerStoragePermit, stateDirectory: string, executionId?: string, deadline?: number): JournalMigrationContext => createTimelineMaintenanceReservation(db, {
  journalFile: permit.journalFile, stateDirectory, storagePermit: permit,
  ...(executionId === undefined ? {} : { executionId }), ...(deadline === undefined ? {} : { deadline }),
});

export const controllerJournalWriteOptions = (file: string, permit: ControllerStoragePermit, stateDirectory: string, executionId?: string, deadline?: number, onMigration?: SqliteMigrationReporter) => {
  assertControllerStoragePermit(permit, file);
  const observation: ControllerStorageObservation = { role: "upgrade-only", roleResult: "pending" };
  const contexts = new WeakMap<Database.Database, JournalMigrationContext>();
  return { file, onMigration: importReporter(observation, onMigration), format: controllerJournalFormatForMigration(db => {
    if (observation.db !== db) observeControllerStorage(observation, db);
    let context = contexts.get(db);
    if (context === undefined) { context = createControllerJournalMigrationContext(db, permit, stateDirectory, executionId, deadline); contexts.set(db, context); }
    return context;
  }), assertMigrationAllowed: (db: Database.Database, source: Parameters<typeof assertJournalMigrationAllowed>[1]): void => {
    observeControllerStorage(observation, db);
    try { assertJournalMigrationAllowed(db, source); observation.roleResult = "admitted"; }
    catch (cause) { observation.roleResult = "rejected"; throw cause; }
  } };
};

/** Current-schema reads remain lock-free; only actual upgrades request ownership. */
export const controllerJournalReadOptions = (file: SqliteDatabaseSource, existingPermit?: ControllerStoragePermit, onMigration?: SqliteMigrationReporter) => {
  let heldPermit = existingPermit;
  const observation: ControllerStorageObservation = { role: "upgrade-only", roleResult: "pending" };
  const contexts = new WeakMap<Database.Database, JournalMigrationContext>();
  if (existingPermit !== undefined && typeof file === "string") assertControllerStoragePermit(existingPermit, file);
  return {
    file,
    onMigration: importReporter(observation, onMigration),
    format: controllerJournalFormatForMigration(db => {
      if (observation.db !== db) observeControllerStorage(observation, db);
      if (heldPermit === undefined) throw new Error("Controller journal migration requires its original storage permit and reserved-write context.");
      let context = contexts.get(db);
      if (context === undefined) { context = createControllerJournalMigrationContext(db, heldPermit, controllerJournalStateDirectory(heldPermit.journalFile)); contexts.set(db, context); }
      return context;
    }),
    assertMigrationAllowed: (db: Database.Database, source: Parameters<typeof assertJournalMigrationAllowed>[1]): void => {
      observeControllerStorage(observation, db);
      try { assertJournalMigrationAllowed(db, source); observation.roleResult = "admitted"; }
      catch (cause) { observation.roleResult = "rejected"; throw cause; }
    },
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

const assertOwnerStopped = (row: ControllerStorageExecutionRow): void => {
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
export const assertControllerStorageRole = (request: ControllerStorageRequest, row: ControllerStorageExecutionRow | undefined): ControllerSnapshot | null => {
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

const capacityCause = (cause: unknown): Error | undefined => {
  if (isControllerStorageCapacityError(cause)) return cause;
  if (cause instanceof AggregateError || cause instanceof SqliteAccessError && cause.kind === "cleanup-failed") return undefined;
  return cause instanceof Error ? capacityCause(cause.cause) : undefined;
};
export const controllerTimelineCleanupPending = (db: Database.Database): boolean => {
  const row = db.prepare("SELECT legacy_timeline_cleanup_pending AS pending FROM execution WHERE id=1").get() as { pending: number } | undefined;
  if (row !== undefined && row.pending !== 0 && row.pending !== 1) throw new Error("Controller timeline cleanup marker is invalid.");
  return row?.pending === 1;
};

/** Own migration, stopped maintenance and normal admission before an ordinary writer can commit its generation. */
export const prepareControllerStorage = (request: ControllerStorageRequest, storagePermit: ControllerStoragePermit, onMigration?: SqliteMigrationReporter): ControllerStoragePreparation => {
  assertControllerStoragePermit(storagePermit, request.journalFile);
  if (!path.isAbsolute(request.stateDirectory)) throw new TypeError("Controller storage state directory must be absolute.");
  let db: Database.Database | undefined, reservation: TimelineMaintenanceReservation | undefined, snapshot: ControllerSnapshot | null = null;
  let outcome: SqliteOutcome = "not-started", failure: unknown, result: ControllerStoragePreparation | undefined;
  const observation: ControllerStorageObservation = { role: request.mode, roleResult: "pending" };
  const context = (connection: Database.Database): JournalMigrationContext => {
    if (observation.db !== connection) observeControllerStorage(observation, connection, request.mode === "writer" ? request.ticket : undefined);
    if (reservation === undefined) reservation = createTimelineMaintenanceReservation(connection, { ...request, storagePermit, ...(request.mode === "upgrade-only" ? {} : { executionId: request.ticket.executionId }) });
    return reservation;
  };
  const format = controllerJournalFormatForMigration(context);

  try {
    db = openSqliteDatabase({ file: request.journalFile, format, allowCreate: request.mode === "writer", timeoutMs: storageTimeout(request.deadline), onMigration: importReporter(observation, onMigration, request.mode === "writer" ? request.ticket : undefined),
      assertMigrationAllowed: (connection, source) => {
        observeControllerStorage(observation, connection, request.mode === "writer" ? request.ticket : undefined);
        try { assertJournalMigrationAllowed(connection, source, 10); if (source.version !== 0) assertControllerStorageRole(request, controllerStorageExecutionRow(connection)); observation.roleResult = "admitted"; }
        catch (cause) { observation.roleResult = "rejected"; throw cause; }
      },
      onReady: connection => {
        try {
          storageTimeout(request.deadline);
          snapshot = assertControllerStorageRole(request, controllerStorageExecutionRow(connection));
          observeControllerStorage(observation, connection, request.mode === "writer" ? request.ticket : undefined);
          if (snapshot === null) {
            assertNoOrphanTimelineSource(request.journalFile);
            if (openTimelineStore(connection, { assertWrite: () => { throw new Error("Controller admission is read-only."); } }).totals().entryCount !== 0) throw new Error("SQL timeline source has no original controller execution.");
          } else if (!existsSync(path.join(`${request.journalFile}.pending-content`, "manifest.json"))) throw new Error("Pending archive source is missing.");
          if (!connection.memory) chmodSync(request.journalFile, 0o600);
          observation.roleResult = "admitted";
        } catch (cause) { observation.roleResult = "rejected"; throw new ControllerStorageAdmissionError(cause); }
      },
    });
    outcome = "committed";
    storageTimeout(request.deadline);
    reservation ??= createTimelineMaintenanceReservation(db, { ...request, storagePermit, ...(request.mode === "upgrade-only" ? {} : { executionId: request.ticket.executionId }) });
    readSqliteDatabase({ file: request.journalFile, format: controllerJournalFormat, onMissing: () => { throw new Error("Controller journal disappeared before committed content readback."); } }, connection => openTimelineStore(connection, { assertWrite: () => { throw new Error("Controller preparation readback is read-only."); } }).totals());
    storageTimeout(request.deadline);
    if (request.mode === "upgrade-only") {
      const cleanupPending = controllerTimelineCleanupPending(db);
      if (cleanupPending) reservation.refresh(); else reservation.settleNormalAdmission();
      result = { kind: "prepared", snapshot, legacyTimelineCleanupPending: cleanupPending };
    } else result = maintainControllerTimeline({ db, request, storagePermit, reservation, ...(onMigration === undefined ? {} : { onMigration }) });
    storageTimeout(request.deadline);
  } catch (cause) { failure = cause; if (outcome !== "committed" || cause instanceof SqliteAccessError && cause.outcome === "unknown") outcome = cause instanceof SqliteAccessError ? cause.outcome : sqliteTransactionOutcome(cause); }
  if (db !== undefined && db.open) try { closeSqliteDatabase(db, { file: request.journalFile, format }, outcome); }
  catch (close) { throw new SqliteAccessError("cleanup-failed", { database: format.name, file: request.journalFile, phase: "timeline-preparation-close" }, { cause: failure === undefined ? close : new AggregateError([failure, close], "Controller timeline preparation and close failed."), outcome, connectionClosed: !db.open }); }
  if (failure !== undefined) {
    if (!(failure instanceof SqliteAccessError)) failure = new SqliteAccessError("migration-failed", { database: format.name, file: request.journalFile, phase: "storage-preparation" }, { cause: failure, outcome, connectionClosed: db === undefined || !db.open });
    if (capacityCause(failure) !== undefined && failure instanceof Error) return { kind: "waiting", reason: "physical_capacity", cause: failure };
    throw failure;
  }
  return result!;
};
