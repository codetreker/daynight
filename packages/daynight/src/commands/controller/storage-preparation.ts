import Database from "better-sqlite3";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { MaintenanceLockHeldError } from "../../platform/instance-lock.js";
import { closeSqliteDatabase, openSqliteDatabase, readSqliteDatabase, reportSqliteMigrationEvent, runSqliteImmediate, sqliteTransactionOutcome, type SqliteDatabaseSource, type SqliteMigrationEvent, type SqliteMigrationReporter } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../platform/sqlite-format.js";
import { canonicalId } from "../../api/parse.js";
import { serializeSqliteError, SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { assertJournalMigrationAllowed, controllerJournalFormat, controllerJournalFormatForMigration, type JournalMigrationContext } from "./journal-format.js";
import { controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { validateWindowsStoredStopProof, type ControllerSnapshot } from "./lifecycle-store.js";
import { assertNoOrphanTimelineSource } from "./content/migration.js";
import { maintainControllerTimeline } from "./content/maintenance.js";
import { openTimelineStore } from "./content/timeline-store.js";
import { acquireControllerStoragePermit, assertControllerStoragePermit, isControllerStorageLockHeld, type ControllerStoragePermit } from "./storage-lock.js";
import { isControllerStorageCapacityError } from "./storage-capacity.js";
import { controllerJournalPhysicalBytes } from "./media/metadata-budget.js";

export type { JournalMigrationContext } from "./journal-format.js";
export type ControllerStorageRequest = { journalFile: string; deadline?: number } & (
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
  role: ControllerStorageRequest["mode"] | "upgrade-only";
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
const journalReporter = (observation: ControllerStorageObservation, reporter?: SqliteMigrationReporter, freshTicket?: ControllerLaunchTicket): SqliteMigrationReporter => event => {
  if (observation.role !== "upgrade-only" && event.kind === "completed" && observation.db?.open) observeControllerStorage(observation, observation.db, freshTicket);
  return reportControllerStorageEvent({ ...event, phase: "journal-migration", storage: { ...event.storage, sqlitePhase: event.phase } }, observation, reporter);
};

export const controllerJournalWriteOptions = (file: string, permit: ControllerStoragePermit, onMigration?: SqliteMigrationReporter) => {
  assertControllerStoragePermit(permit, file);
  const observation: ControllerStorageObservation = { role: "upgrade-only", roleResult: "pending" };
  return { file, onMigration: journalReporter(observation, onMigration), format: controllerJournalFormatForMigration(db => {
    observation.db = db;
    return { storagePermit: permit };
  }), assertMigrationAllowed: (db: Database.Database, source: Parameters<typeof assertJournalMigrationAllowed>[1]): void => {
    observation.db = db;
    try { assertJournalMigrationAllowed(db, source); observation.roleResult = "admitted"; }
    catch (cause) { observation.roleResult = "rejected"; throw cause; }
  } };
};

/** Current-schema reads remain lock-free; only actual upgrades request ownership. */
export const controllerJournalReadOptions = (file: SqliteDatabaseSource, existingPermit?: ControllerStoragePermit, onMigration?: SqliteMigrationReporter) => {
  let heldPermit = existingPermit;
  const observation: ControllerStorageObservation = { role: "upgrade-only", roleResult: "pending" };
  if (existingPermit !== undefined && typeof file === "string") assertControllerStoragePermit(existingPermit, file);
  return {
    file,
    onMigration: journalReporter(observation, onMigration),
    format: controllerJournalFormatForMigration(db => {
      observation.db = db;
      if (heldPermit === undefined) throw new Error("Controller journal migration requires its original storage permit.");
      return { storagePermit: heldPermit };
    }),
    assertMigrationAllowed: (db: Database.Database, source: Parameters<typeof assertJournalMigrationAllowed>[1]): void => {
      observation.db = db;
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

/** Upgrade under the original permit without admitting a writer or running maintenance. */
export const upgradeControllerJournal = (file: string, permit: ControllerStoragePermit, options: { deadline?: number; onMigration?: SqliteMigrationReporter } = {}): { version: number; legacyTimelineCleanupPending: boolean } => {
  assertControllerStoragePermit(permit, file);
  const observation: ControllerStorageObservation = { role: "upgrade-only", roleResult: "pending" };
  const format = controllerJournalFormatForMigration(db => { observation.db = db; return { storagePermit: permit }; });
  let db: Database.Database | undefined, failure: unknown, outcome: SqliteOutcome = "not-started";
  let result: { version: number; legacyTimelineCleanupPending: boolean } | undefined;
  try {
    db = openSqliteDatabase({ file, format, allowCreate: false, timeoutMs: storageTimeout(options.deadline), onMigration: journalReporter(observation, options.onMigration),
      assertMigrationAllowed: (connection, source) => {
        observation.db = connection;
        try { assertJournalMigrationAllowed(connection, source); observation.roleResult = "admitted"; }
        catch (cause) { observation.roleResult = "rejected"; throw cause; }
      },
    });
    outcome = "committed";
    storageTimeout(options.deadline);
    result = { version: Number(db.pragma("user_version", { simple: true })), legacyTimelineCleanupPending: controllerTimelineCleanupPending(db) };
    storageTimeout(options.deadline);
  } catch (cause) { failure = cause; if (outcome !== "committed" || cause instanceof SqliteAccessError && cause.outcome === "unknown") outcome = cause instanceof SqliteAccessError ? cause.outcome : sqliteTransactionOutcome(cause); }
  if (db !== undefined && db.open) try { closeSqliteDatabase(db, { file, format }, outcome); }
  catch (close) { throw new SqliteAccessError("cleanup-failed", { database: format.name, file, phase: "journal-upgrade-close" }, { cause: failure === undefined ? close : new AggregateError([failure, close], "Controller journal upgrade and close failed."), outcome, connectionClosed: !db.open }); }
  if (failure !== undefined) {
    if (failure instanceof SqliteAccessError) throw failure;
    throw new SqliteAccessError("migration-failed", { database: format.name, file, phase: "journal-upgrade" }, { cause: failure, outcome, connectionClosed: db === undefined || !db.open });
  }
  return result!;
};

/** Own migration, stopped maintenance and normal admission before an ordinary writer can commit its generation. */
export const prepareControllerStorage = (request: ControllerStorageRequest, storagePermit: ControllerStoragePermit, onMigration?: SqliteMigrationReporter): ControllerStoragePreparation => {
  assertControllerStoragePermit(storagePermit, request.journalFile);
  let db: Database.Database | undefined, snapshot: ControllerSnapshot | null = null;
  let outcome: SqliteOutcome = "not-started", failure: unknown, result: ControllerStoragePreparation | undefined;
  let phase: "open" | "admission" | "maintenance" = "open";
  const observation: ControllerStorageObservation = { role: request.mode, roleResult: "pending" };
  const context = (connection: Database.Database): JournalMigrationContext => {
    observation.db = connection;
    return { storagePermit };
  };
  const format = controllerJournalFormatForMigration(context);

  try {
    db = openSqliteDatabase({ file: request.journalFile, format, allowCreate: request.mode === "writer", timeoutMs: storageTimeout(request.deadline), onMigration: journalReporter(observation, onMigration, request.mode === "writer" ? request.ticket : undefined),
      assertMigrationAllowed: (connection, source) => {
        observation.db = connection;
        try { assertJournalMigrationAllowed(connection, source); observation.roleResult = "admitted"; }
        catch (cause) { observation.roleResult = "rejected"; throw cause; }
      },
    });
    phase = "admission";
    runSqliteImmediate(db, () => {
      const connection = db!;
      assertCurrentSqlite(connection, format);
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
      } catch (cause) { observation.roleResult = "rejected"; throw cause; }
    });
    outcome = "committed";
    phase = "maintenance";
    storageTimeout(request.deadline);
    readSqliteDatabase({ file: request.journalFile, format: controllerJournalFormat, onMissing: () => { throw new Error("Controller journal disappeared before committed content readback."); } }, connection => openTimelineStore(connection, { assertWrite: () => { throw new Error("Controller preparation readback is read-only."); } }).totals());
    storageTimeout(request.deadline);
    result = maintainControllerTimeline({ db, request, storagePermit, ...(onMigration === undefined ? {} : { onMigration }) });
    storageTimeout(request.deadline);
  } catch (cause) { failure = cause; outcome = phase === "admission" ? sqliteTransactionOutcome(cause) : cause instanceof SqliteAccessError ? cause.outcome : phase === "open" ? "not-started" : sqliteTransactionOutcome(cause); }
  if (db !== undefined && db.open) try { closeSqliteDatabase(db, { file: request.journalFile, format }, outcome); }
  catch (close) { throw new SqliteAccessError("cleanup-failed", { database: format.name, file: request.journalFile, phase: "timeline-preparation-close" }, { cause: failure === undefined ? close : new AggregateError([failure, close], "Controller timeline preparation and close failed."), outcome, connectionClosed: !db.open }); }
  if (failure !== undefined) {
    if (capacityCause(failure) !== undefined && failure instanceof Error) return { kind: "waiting", reason: "physical_capacity", cause: failure };
    if (phase === "admission" && failure instanceof SqliteAccessError) {
      throw new SqliteAccessError(failure.kind, { database: format.name, file: request.journalFile, phase: "storage-admission" }, { cause: failure, outcome, connectionClosed: db === undefined || !db.open });
    }
    if (phase !== "open" && (failure instanceof Database.SqliteError || failure instanceof SyntaxError || failure instanceof AggregateError || outcome === "unknown" || outcome === "not-started")) {
      throw new SqliteAccessError("operation-failed", { database: format.name, file: request.journalFile, phase: "storage-preparation" }, { cause: failure, outcome, connectionClosed: db === undefined || !db.open });
    }
    throw failure;
  }
  return result!;
};
