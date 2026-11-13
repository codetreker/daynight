import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { canonicalId } from "../../../api/parse.js";
import { syncDirectory } from "../../../platform/durable-json.js";
import { runSqliteImmediate, sqliteTransactionOutcome, type SqliteMigrationEvent, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { serializeSqliteError, SqliteAccessError, type SqliteOutcome } from "../../../platform/sqlite-error.js";
import { currentSqliteVersion, inspectSqlite } from "../../../platform/sqlite-format.js";
import { parseTimelineEntry } from "../../../session/protocol.js";
import { controllerJournalFormat, type JournalMigrationContext } from "../journal-format.js";
import { preflightPendingTimeline } from "../pending-content.js";
import { CONTROLLER_METADATA_BYTES, CONTROLLER_SETTLEMENT_BYTES, controllerJournalPhysicalBytes, controllerMetadataBudget } from "../media/metadata-budget.js";
import { SESSION_ARCHIVE_TIMELINE_MAX_BYTES } from "../../../session/archive.js";
import { controllerStorageMediaUsage, assertControllerStorageCapacity, isControllerStorageCapacityError, reserveControllerStoragePeak } from "../storage-capacity.js";
import { assertControllerStoragePermit, type ControllerStoragePermit } from "../storage-lock.js";
import { assertControllerStorageRole, controllerStorageExecutionRow, controllerTimelineCleanupPending, observeControllerStorage, reportControllerStorageEvent, type ControllerStorageObservation, type ControllerStoragePreparation, type ControllerStorageRequest } from "../storage-preparation.js";
import { openTimelineStore } from "./timeline-store.js";
import { retireLegacyTimelineReferences } from "./resource-files.js";

const timeout = (deadline?: number): number => {
  const remaining = deadline === undefined ? 5000 : deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new Error("Controller timeline maintenance exceeded its deadline.");
  return Math.min(5000, remaining);
};
const warn = (message: string, cause: unknown): void => { process.emitWarning(`${message} ${JSON.stringify(serializeSqliteError(cause))}`); };
const hasTable = (db: Database.Database, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;
const size = (file: string): number => {
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Controller maintenance source is not a private regular file."); return stat.size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
};
const originalExecutionId = (db: Database.Database, expected?: string): string | undefined => {
  const row = controllerStorageExecutionRow(db);
  if (row === undefined) return expected;
  const snapshot = JSON.parse(row.snapshot) as { executionId?: unknown };
  if (typeof snapshot.executionId !== "string" || canonicalId(snapshot.executionId) !== snapshot.executionId || expected !== undefined && expected !== snapshot.executionId) throw new Error("Controller timeline reservation belongs to another execution.");
  return snapshot.executionId;
};

export type TimelineMaintenanceReservation = JournalMigrationContext & {
  refresh(additionalBytes?: number): number;
  settleNormalAdmission(): void;
};
/** The migration allowance charges retained sources and the remaining work, never historical garbage against the normal writer ceiling. */
export const createTimelineMaintenanceReservation = (db: Database.Database, options: {
  journalFile: string; stateDirectory: string; storagePermit: ControllerStoragePermit; executionId?: string; deadline?: number;
}): TimelineMaintenanceReservation => {
  const { journalFile, stateDirectory, storagePermit, deadline } = options;
  let reservedPeak = 0, maximumWrite = 0;
  const assertContext = (): void => {
    assertControllerStoragePermit(storagePermit, journalFile);
    timeout(deadline);
    if (!db.memory && db.name !== journalFile || !path.isAbsolute(stateDirectory)) throw new Error("Controller timeline reservation context is invalid.");
  };
  const refresh = (additionalBytes = 0): number => {
    assertContext();
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new TypeError("Controller timeline growth must be a nonnegative safe integer.");
    const executionId = originalExecutionId(db, options.executionId);
    const metadata = controllerMetadataBudget(journalFile, db).bytes(), media = controllerStorageMediaUsage(journalFile, db);
    let bodyBytes = 0, entryCount = 0, exportBytes = 0, largestWrite = 65536;
    if (hasTable(db, "projection")) {
      let serializedTimelineBytes = Buffer.byteLength('{"entries":[]}');
      for (const row of db.prepare("SELECT CAST(rowid AS TEXT) AS seq,value FROM projection ORDER BY rowid").iterate() as Iterable<{ seq: string; value: string }>) {
        const entry = parseTimelineEntry({ ...JSON.parse(row.value) as object, entrySeq: row.seq });
        const bytes = Buffer.byteLength(JSON.stringify(entry)), backupBytes = Buffer.byteLength(JSON.stringify(row));
        serializedTimelineBytes += bytes + (entryCount > 0 ? 1 : 0); entryCount++; bodyBytes += bytes;
        if (entryCount > 100000 || serializedTimelineBytes > SESSION_ARCHIVE_TIMELINE_MAX_BYTES) throw new Error("Pending session timeline budget exceeded.");
        exportBytes += bytes * 2 + backupBytes;
        largestWrite = Math.max(largestWrite, bytes + backupBytes + 16384);
      }
    } else if (hasTable(db, "content_index")) {
      const row = controllerStorageExecutionRow(db);
      if (row === undefined) {
        if (db.prepare("SELECT 1 FROM content_index LIMIT 1").get() !== undefined) throw new Error("Legacy archive content has no original controller execution.");
      } else {
        const snapshot = JSON.parse(row.snapshot) as { sessionId: string };
        const preflight = () => preflightPendingTimeline(db, snapshot.sessionId);
        const totals = db.inTransaction ? preflight() : db.transaction(preflight).deferred();
        bodyBytes = totals.byteLength; entryCount = totals.entryCount;
      }
      const columns = db.pragma("table_info(content_index)") as { name: string }[];
      if (columns.every(column => column.name !== "content_bytes")) exportBytes += bodyBytes;
      largestWrite = Math.max(largestWrite, bodyBytes + 16384);
    }
    if (hasTable(db, "resources")) {
      let count = 0, descriptors = 0, resourceBytes = 0;
      for (const row of db.prepare("SELECT descriptor,content FROM resources").iterate() as Iterable<{ descriptor: string; content: Buffer | null }>) {
        count++; descriptors += Buffer.byteLength(row.descriptor); resourceBytes += row.content === null ? 0 : row.content.length;
        if (count > 1000 || descriptors > 4 * 1048576 || resourceBytes > 1073741824) throw new Error("Pending session resource budget exceeded.");
        const backup = Buffer.byteLength(JSON.stringify({ descriptor: row.descriptor, content: row.content === null ? null : row.content.toString("base64") }));
        exportBytes += (row.content === null ? 0 : row.content.length) + backup + Buffer.byteLength(row.descriptor) + 128;
        largestWrite = Math.max(largestWrite, backup + 16384);
      }
    }
    const physical = controllerJournalPhysicalBytes(journalFile, db);
    const importedGrowth = bodyBytes * 2 + entryCount * 256 + 65536;
    const projectedDatabase = Math.max(physical.databaseBytes, Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true }))) + importedGrowth;
    const growth = exportBytes + importedGrowth + projectedDatabase * 2 + Math.max(largestWrite, additionalBytes) + CONTROLLER_SETTLEMENT_BYTES;
    const absolute = Math.max(reservedPeak, media.reservedBytes + Math.max(CONTROLLER_METADATA_BYTES + CONTROLLER_SETTLEMENT_BYTES, metadata + growth));
    if (!Number.isSafeInteger(absolute)) throw new Error("Controller timeline peak exceeds the supported byte count.");
    if (!db.memory) reserveControllerStoragePeak(journalFile, stateDirectory, executionId, absolute, growth + Math.max(0, media.reservedBytes - media.actualBytes), deadline);
    reservedPeak = absolute; maximumWrite = Math.max(maximumWrite, largestWrite, additionalBytes);
    return absolute;
  };
  const assertReservedWrite = (additionalBytes: number): void => {
    assertContext();
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new TypeError("Controller timeline growth must be a nonnegative safe integer.");
    if (reservedPeak === 0) refresh(additionalBytes);
    else if (additionalBytes > maximumWrite) throw new Error("Controller timeline write exceeds its admitted maintenance peak.");
  };
  const reservation: TimelineMaintenanceReservation = {
    storagePermit,
    refresh,
    assertReservedWrite,
    assertPendingWrite: assertReservedWrite,
    settleNormalAdmission: () => {
      assertControllerStoragePermit(storagePermit, journalFile);
      assertControllerStorageCapacity(journalFile, db, stateDirectory, originalExecutionId(db, options.executionId), 0, deadline);
    },
  };
  return reservation;
};

type RetainedSource = { file: string; dev: number; ino: number; bytes: number; modified: number };
const privateDirectory = (directory: string): void => {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Controller timeline source must be a private directory.");
};
const retirementSources = (journalFile: string, sessionId: string): RetainedSource[] => {
  const root = `${journalFile}.pending-content`;
  privateDirectory(root);
  const manifestFile = path.join(root, "manifest.json"), manifestStat = lstatSync(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || process.platform !== "win32" && (manifestStat.mode & 0o077) !== 0) throw new Error("Controller timeline manifest is not private.");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { schemaVersion: unknown; sessionId: unknown };
  if (manifest.schemaVersion !== 1 || manifest.sessionId !== sessionId) throw new Error("Controller timeline source belongs to another session.");
  const sources: RetainedSource[] = [];
  for (const kind of ["entries", "timeline", "legacy-sql"] as const) {
    const directory = path.join(root, kind);
    try { privateDirectory(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (kind === "legacy-sql") {
      const markerFile = path.join(root, "migration.json");
      if (size(markerFile) === 0) throw new Error("Controller migration backup has no durable identity.");
      const marker = JSON.parse(readFileSync(markerFile, "utf8")) as { migrationId: unknown; sourceHash: unknown; phase: unknown };
      if (typeof marker.migrationId !== "string" || canonicalId(marker.migrationId) !== marker.migrationId || typeof marker.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(marker.sourceHash) || !["files_durable", "committed", "verified"].includes(String(marker.phase))) throw new Error("Controller migration backup identity is invalid.");
    }
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Controller timeline retirement found an unsafe source.");
      if (kind === "legacy-sql" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.resource\.json$/.test(name)) continue;
      if (kind === "entries") {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(name)) throw new Error("Controller timeline retirement found an unrecognized candidate.");
      } else if (kind === "timeline") {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Controller timeline retirement found an unrecognized legacy source.");
        const entry = parseTimelineEntry(JSON.parse(readFileSync(file, "utf8")));
        if (`${createHash("sha256").update(entry.entryId).digest("hex")}.json` !== name) throw new Error("Controller legacy timeline source identity differs from its filename.");
      } else {
        if (!/^[1-9][0-9]*\.timeline\.json$/.test(name)) throw new Error("Controller timeline retirement found an unrecognized migration backup.");
        const row = JSON.parse(readFileSync(file, "utf8")) as { seq: string; value: string };
        if (`${row.seq}.timeline.json` !== name || typeof row.value !== "string") throw new Error("Controller migration timeline backup identity is invalid.");
        parseTimelineEntry({ ...JSON.parse(row.value) as object, entrySeq: row.seq });
      }
      sources.push({ file, dev: stat.dev, ino: stat.ino, bytes: stat.size, modified: stat.mtimeMs });
    }
  }
  return sources;
};
const retire = (sources: readonly RetainedSource[], journalFile: string): void => {
  const directories = new Set<string>();
  for (const name of ["entries", "timeline", "legacy-sql"]) {
    const directory = path.join(`${journalFile}.pending-content`, name);
    try { privateDirectory(directory); directories.add(directory); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  for (const source of sources) {
    let stat;
    try { stat = lstatSync(source.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== source.dev || stat.ino !== source.ino || stat.size !== source.bytes || stat.mtimeMs !== source.modified) throw new Error("Controller timeline source changed before retirement.");
    unlinkSync(source.file); directories.add(path.dirname(source.file));
  }
  for (const directory of directories) syncDirectory(directory);
};

class TimelineReaderBusyError extends Error {
  constructor(readonly busy: number, readonly logFrames: number, readonly checkpointedFrames: number) { super("Controller timeline maintenance is waiting for a reader checkpoint."); }
}
const checkpoint = (db: Database.Database, deadline?: number): { busy: number; logFrames: number; checkpointedFrames: number } => {
  if (db.inTransaction) throw new Error("Controller timeline checkpoints cannot run inside a transaction.");
  db.pragma(`busy_timeout = ${timeout(deadline)}`);
  const rows = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || ![row.busy, row.log, row.checkpointed].every(Number.isSafeInteger) || row.busy < 0 || row.log < 0 || row.checkpointed < 0) throw new Error("Controller timeline checkpoint returned an invalid result.");
  if (row.busy !== 0 || row.log !== row.checkpointed) throw new TimelineReaderBusyError(row.busy, row.log, row.checkpointed);
  return { busy: row.busy, logFrames: row.log, checkpointedFrames: row.checkpointed };
};

const vacuum = (db: Database.Database, deadline?: number): void => {
  const directory = `${db.name}.timeline-maintenance`;
  mkdirSync(directory, { recursive: true, mode: 0o700 }); privateDirectory(directory);
  if (readdirSync(directory).length !== 0) throw new Error("Controller timeline maintenance has unrecognized retained temporary files.");
  if (lstatSync(directory).dev !== lstatSync(path.dirname(db.name)).dev) throw new Error("Controller journal compaction requires temporary storage on its original volume.");
  accessSync(directory, constants.W_OK | (process.platform === "win32" ? 0 : constants.X_OK));
  syncDirectory(path.dirname(directory)); timeout(deadline);
  const names = ["SQLITE_TMPDIR", "TMPDIR", "TMP", "TEMP"] as const;
  const previous = names.map(name => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }));
  let failure: unknown;
  // The pinned SQLite VFS reads these values for each temporary file. This
  // synchronous scope has no callback or await, and our runtime has no SQLite
  // worker threads: https://github.com/WiseLibs/better-sqlite3/blob/0d704b07468d7a8d993badce89cf2b0fbfb8dda1/deps/sqlite3/sqlite3.c#L46919-L46943
  try {
    for (const name of names) process.env[name] = directory;
    db.exec("VACUUM");
  } catch (cause) { failure = cause; }
  finally {
    const failures: unknown[] = [];
    for (const old of previous) {
      try { if (old.present) process.env[old.name] = old.value!; else delete process.env[old.name]; }
      catch (cause) { failures.push(cause); }
    }
    if (failures.length !== 0) failure = new AggregateError(failure === undefined ? failures : [failure, ...failures], "Controller journal compaction environment restoration failed.", failure === undefined ? undefined : { cause: failure });
  }
  // sqlite3RunVacuum has finalized its statements and detached its temporary
  // database before exec returns, including its error path. Unknown leftovers
  // remain visible and charged rather than being swept as owned data:
  // https://github.com/WiseLibs/better-sqlite3/blob/0d704b07468d7a8d993badce89cf2b0fbfb8dda1/deps/sqlite3/sqlite3.c#L162570-L162599
  try {
    if (readdirSync(directory).length !== 0) throw new Error("Controller journal compaction retained temporary files.");
    syncDirectory(directory); rmdirSync(directory); syncDirectory(path.dirname(directory));
  } catch (cleanup) {
    throw failure === undefined ? cleanup : new AggregateError([failure, cleanup], "Controller journal compaction and temporary storage cleanup failed.", { cause: failure });
  }
  if (failure !== undefined) throw failure;
  timeout(deadline);
};

const validateCommitted = (db: Database.Database): ReturnType<ReturnType<typeof openTimelineStore>["totals"]> => {
  const check = (reader: Database.Database) => reader.transaction(() => {
    if (inspectSqlite(reader, controllerJournalFormat).kind !== "current") throw new Error("Controller timeline maintenance requires the complete current schema.");
    return openTimelineStore(reader, { assertWrite: () => { throw new Error("Controller maintenance readback is read-only."); } }).totals();
  }).deferred();
  if (db.memory) return check(db);
  const reader = new Database(db.name, { readonly: true, fileMustExist: true });
  let value: ReturnType<typeof check> | undefined, failure: unknown;
  try { value = check(reader); } catch (cause) { failure = cause; }
  try { reader.close(); }
  catch (close) { throw failure === undefined ? close : new AggregateError([failure, close], "Controller timeline readback and close failed.", { cause: failure }); }
  if (failure !== undefined) throw failure;
  return value!;
};

/** Operate an already committed current-format connection under its original permit; the caller retains both handles. */
export const maintainControllerTimeline = (options: {
  db: Database.Database; request: Exclude<ControllerStorageRequest, { mode: "upgrade-only" }>; storagePermit: ControllerStoragePermit;
  reservation?: TimelineMaintenanceReservation; onMigration?: SqliteMigrationReporter;
}): ControllerStoragePreparation => {
  const { db, request, storagePermit } = options;
  assertControllerStoragePermit(storagePermit, request.journalFile);
  if (db.inTransaction || db.memory || db.name !== request.journalFile) throw new Error("Controller timeline maintenance requires its original idle connection.");
  const currentVersion = currentSqliteVersion(controllerJournalFormat);
  const observation: ControllerStorageObservation = { role: request.mode, roleResult: "pending" };
  observeControllerStorage(observation, db, request.mode === "writer" ? request.ticket : undefined);
  let snapshot: ReturnType<typeof assertControllerStorageRole>;
  try { snapshot = assertControllerStorageRole(request, controllerStorageExecutionRow(db)); observation.roleResult = "admitted"; }
  catch (cause) {
    observation.roleResult = "rejected";
    reportControllerStorageEvent({ migrationId: randomUUID(), database: controllerJournalFormat.name, file: request.journalFile, kind: "failed", phase: "storage-admission", fromVersion: currentVersion, toVersion: currentVersion, durationMs: 0, outcome: "not-started", error: serializeSqliteError(cause) }, observation, options.onMigration);
    throw cause;
  }
  if (db.pragma("journal_mode", { simple: true }) !== "wal") throw new Error("Controller timeline maintenance requires its original WAL journal.");
  db.pragma("synchronous = FULL"); db.pragma("wal_autocheckpoint = 1000");
  const reservation = options.reservation ?? createTimelineMaintenanceReservation(db, { ...request, storagePermit, ...(snapshot === null ? {} : { executionId: snapshot.executionId }) });
  const started = Date.now(), migrationId = randomUUID();
  const report = (phase: string, kind: SqliteMigrationEvent["kind"], metrics: Record<string, number | string | boolean> = {}, outcome: SqliteOutcome = "committed", cause?: unknown): void => {
    const event: SqliteMigrationEvent = { migrationId, database: controllerJournalFormat.name, file: request.journalFile, kind, phase, fromVersion: currentVersion, toVersion: currentVersion, durationMs: Date.now() - started, outcome, storage: metrics, ...(cause === undefined ? {} : { error: serializeSqliteError(cause) }) };
    reportControllerStorageEvent(event, observation, options.onMigration);
  };
  let phase = "storage-admission", maintenanceOutcome: SqliteOutcome = "committed";
  try {
    const totals = validateCommitted(db);
    if (!controllerTimelineCleanupPending(db)) { reservation.settleNormalAdmission(); report(phase, "completed", { ...totals, pending: false }); return { kind: "prepared", snapshot, legacyTimelineCleanupPending: false }; }
    reservation.refresh();
    if (snapshot === null) throw new Error("Controller timeline cleanup has no original execution.");
    phase = "legacy-timeline-retirement"; report(phase, "started", { ...totals });
    const sources = retirementSources(request.journalFile, snapshot.sessionId);
    const before = controllerMetadataBudget(request.journalFile, db).bytes();
    const first = checkpoint(db, request.deadline);
    report(phase, "started", { ...first, remainingFrames: first.logFrames - first.checkpointedFrames, oldFileBytes: sources.reduce((sum, source) => sum + source.bytes, 0) });
    retireLegacyTimelineReferences(request.journalFile, snapshot.sessionId);
    retire(sources, request.journalFile);
    if (retirementSources(request.journalFile, snapshot.sessionId).length !== 0) throw new Error("Controller timeline retirement left recognized source files.");
    report(phase, "completed", { retiredBytes: sources.reduce((sum, source) => sum + source.bytes, 0) });
    phase = "journal-compaction"; report(phase, "started", { ...controllerJournalPhysicalBytes(request.journalFile, db) });
    reservation.refresh();
    const pre = checkpoint(db, request.deadline);
    vacuum(db, request.deadline);
    const post = checkpoint(db, request.deadline);
    const physical = controllerJournalPhysicalBytes(request.journalFile, db);
    const pageBytes = Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true }));
    if (physical.databaseBytes !== pageBytes || physical.walBytes !== 0 || physical.journalBytes !== 0) throw new Error("Controller journal compaction has not reached the physical database file.");
    validateCommitted(db);
    if (retirementSources(request.journalFile, snapshot.sessionId).length !== 0) throw new Error("Controller timeline sources reappeared during compaction.");
    report(phase, "completed", { ...physical, preCheckpointBusy: pre.busy, preCheckpointLogFrames: pre.logFrames, preCheckpointedFrames: pre.checkpointedFrames, preCheckpointRemainingFrames: pre.logFrames - pre.checkpointedFrames, postCheckpointBusy: post.busy, postCheckpointLogFrames: post.logFrames, postCheckpointedFrames: post.checkpointedFrames, postCheckpointRemainingFrames: post.logFrames - post.checkpointedFrames, reclaimedBytes: before - controllerMetadataBudget(request.journalFile, db).bytes() });
    phase = "storage-admission"; report(phase, "started");
    try { runSqliteImmediate(db, () => { db.prepare("UPDATE execution SET legacy_timeline_cleanup_pending=0 WHERE id=1 AND legacy_timeline_cleanup_pending=1").run(); }); }
    catch (cause) {
      maintenanceOutcome = sqliteTransactionOutcome(cause);
      const uncertainClear = (failure: unknown): SqliteAccessError => new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file: request.journalFile, phase: "timeline-cleanup-marker", fromVersion: currentVersion, toVersion: currentVersion }, { cause: failure, outcome: maintenanceOutcome, connectionClosed: !db.open });
      // The actual marker is observed before another caller can decide whether
      // retirement or settlement remains; an unknown COMMIT is never replayed.
      if (maintenanceOutcome === "unknown" && db.open && !db.inTransaction) {
        try { maintenanceOutcome = controllerTimelineCleanupPending(db) ? "rolled-back" : "committed"; validateCommitted(db); }
        catch (readback) { throw uncertainClear(new AggregateError([cause, readback], "Controller timeline cleanup commit outcome and readback are uncertain.", { cause })); }
      }
      if (maintenanceOutcome === "unknown") throw uncertainClear(cause);
      throw cause;
    }
    validateCommitted(db);
    if (controllerTimelineCleanupPending(db)) throw new Error("Controller timeline cleanup marker did not commit.");
    reservation.settleNormalAdmission();
    report(phase, "completed", { ...controllerJournalPhysicalBytes(request.journalFile, db), pending: false });
    return { kind: "prepared", snapshot, legacyTimelineCleanupPending: false };
  } catch (cause) {
    if (cause instanceof TimelineReaderBusyError || isControllerStorageCapacityError(cause)) observation.roleResult = "waiting";
    let pendingObservation: boolean | string = "unknown";
    try { if (db.open && !db.inTransaction) pendingObservation = controllerTimelineCleanupPending(db); }
    catch (observation) { warn("Controller timeline failure marker observation failed.", observation); }
    report(phase, "failed", { pending: pendingObservation, ...(cause instanceof TimelineReaderBusyError ? { checkpointBusy: cause.busy, logFrames: cause.logFrames, checkpointedFrames: cause.checkpointedFrames, remainingFrames: cause.logFrames - cause.checkpointedFrames } : {}) }, cause instanceof SqliteAccessError ? cause.outcome : maintenanceOutcome, cause);
    if (cause instanceof TimelineReaderBusyError) return { kind: "waiting", reason: "reader_busy", cause };
    if (isControllerStorageCapacityError(cause)) return { kind: "waiting", reason: "physical_capacity", cause };
    throw cause;
  }
};
