import { randomUUID } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MaintenanceLockHeldError, type MaintenancePermit } from "./instance-lock.js";
import { currentSqliteVersion, inspectSqlite, upgradeSqlite, type SqliteFormat, type SqliteSource, type SqliteTransition } from "./sqlite-format.js";
import { SqliteAccessError, serializeSqliteError, type SqliteOutcome } from "./sqlite-error.js";

export type SqliteMigrationEvent = {
  readonly migrationId: string; readonly database: string; readonly file: string;
  readonly kind: "started" | "completed" | "failed"; readonly phase: string;
  readonly fromVersion: number; readonly toVersion: number; readonly stepVersion?: number;
  readonly durationMs: number; readonly outcome: SqliteOutcome;
};
export type SqliteMigrationReporter = (event: SqliteMigrationEvent) => undefined;
type CommonOptions = { file: string; format: SqliteFormat; timeoutMs?: number; onMigration?: SqliteMigrationReporter; assertMigrationAllowed?: (db: Database.Database, source: SqliteSource) => void };
export type OpenSqliteOptions = CommonOptions & { allowEmpty: boolean; onReady?: (db: Database.Database) => void };
export type ReadSqliteOptions<T> = CommonOptions & { onMissing: () => T; acquireMaintenance?: () => MaintenancePermit };
const outcomes = new WeakMap<object, SqliteOutcome>();
const phases = new WeakMap<object, string>();
const markOutcome = (error: unknown, outcome: SqliteOutcome, phase?: string): void => { if (typeof error === "object" && error !== null) { outcomes.set(error, outcome); if (phase !== undefined) phases.set(error, phase); } };
export const sqliteTransactionOutcome = (error: unknown): SqliteOutcome => typeof error === "object" && error !== null ? outcomes.get(error) ?? "unknown" : "unknown";
const thenable = (value: unknown): boolean => typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";

const runSqliteTransaction = <T>(db: Database.Database, mode: "DEFERRED" | "IMMEDIATE", action: () => T): T => {
  if (db.inTransaction) throw new Error(`SQLite ${mode.toLowerCase()} boundary cannot nest an existing transaction.`);
  let phase: "begin" | "action" | "commit" = "begin";
  try {
    db.exec(`BEGIN ${mode}`); phase = "action";
    const value = action();
    if (thenable(value)) throw new TypeError("SQLite transaction callbacks must be synchronous.");
    phase = "commit"; db.exec("COMMIT");
    return value;
  } catch (primary) {
    let outcome: SqliteOutcome = phase === "begin" ? "not-started" : phase === "action" && !db.inTransaction ? "rolled-back" : "unknown";
    if (db.inTransaction) {
      try { db.exec("ROLLBACK"); outcome = "rolled-back"; }
      catch (rollback) {
        const aggregate = new AggregateError([primary, rollback], "SQLite operation and rollback failed.");
        markOutcome(aggregate, "unknown", "rollback"); throw aggregate;
      }
    }
    markOutcome(primary, outcome, phase); throw primary;
  }
};
/** Migration boundaries own the whole transaction; domain savepoints remain outside this helper. */
export const runSqliteImmediate = <T>(db: Database.Database, action: () => T): T => runSqliteTransaction(db, "IMMEDIATE", action);
const missingError = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export const sqliteDatabaseIsMissing = (file: string): boolean => {
  let candidate = file;
  for (;;) {
    let metadata;
    try { metadata = lstatSync(candidate); }
    catch (error) {
      if (!missingError(error)) throw error;
      const parent = path.dirname(candidate); if (parent === candidate) throw error;
      candidate = parent; continue;
    }
    if (candidate === file) return false;
    const ancestor = metadata.isSymbolicLink() ? statSync(candidate) : metadata;
    if (!ancestor.isDirectory()) throw new Error("The SQLite database path ancestor is not a directory.");
    return true;
  }
};
const validateOptions = (options: CommonOptions): number => {
  if (!path.isAbsolute(options.file)) throw new TypeError("The SQLite database path must be absolute.");
  currentSqliteVersion(options.format);
  const timeout = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw new TypeError("SQLite busy timeout must be a safe integer between 1 and 60000 milliseconds.");
  return timeout;
};
const stderrReporter: SqliteMigrationReporter = (event) => { process.stderr.write(`${JSON.stringify({ kind: `sqlite-migration-${event.kind}`, sqlite: event })}\n`); };
const context = (options: CommonOptions, phase: string, fromVersion?: number) => ({ database: options.format.name, file: options.file, phase, ...(fromVersion === undefined ? {} : { fromVersion }), toVersion: currentSqliteVersion(options.format) });
const accessContext = (error: unknown, depth = 0): SqliteAccessError | undefined => {
  if (error instanceof SqliteAccessError) return error;
  if (depth < 6 && error instanceof AggregateError) {
    for (const nested of error.errors as unknown[]) { const found = accessContext(nested, depth + 1); if (found !== undefined) return found; }
  }
  return undefined;
};
const wrap = (options: CommonOptions, phase: string, cause: unknown, closed: boolean, outcome: SqliteOutcome, fromVersion?: number): SqliteAccessError => {
  const original = accessContext(cause);
  const kind = phase === "close" || phase === "report" || phase === "release" ? "cleanup-failed" : original !== undefined ? original.kind : phase === "admission" ? "upgrade-blocked" : "migration-failed";
  return new SqliteAccessError(kind, { ...context(options, phase, original?.context.fromVersion === undefined ? fromVersion : original.context.fromVersion), ...(original?.context.stepVersion === undefined ? {} : { stepVersion: original.context.stepVersion }) }, { cause, connectionClosed: closed, outcome });
};
export const closeSqliteDatabase = (db: Database.Database, options: Pick<CommonOptions, "file" | "format">, outcome: SqliteOutcome = "unknown"): void => {
  try { db.close(); } catch (cause) { throw new SqliteAccessError("cleanup-failed", context(options, "close"), { cause, outcome }); }
};

export const openSqliteDatabase = (options: OpenSqliteOptions): Database.Database => {
  const timeout = validateOptions(options), report = options.onMigration === undefined ? stderrReporter : options.onMigration;
  let db: Database.Database;
  try { db = new Database(options.file, { timeout, fileMustExist: !options.allowEmpty }); }
  catch (cause) { throw wrap(options, "open", cause, true, "not-started"); }
  let phase = "inspect", source: SqliteSource | undefined, migrationId: string | undefined, started = 0, committed = false;
  const event = (kind: SqliteMigrationEvent["kind"], eventPhase: string, outcome: SqliteOutcome, transition?: SqliteTransition | null): SqliteMigrationEvent => ({ migrationId: migrationId!, database: options.format.name, file: options.file, kind, phase: eventPhase, fromVersion: transition === null ? currentSqliteVersion(options.format) : transition?.fromVersion ?? source!.version, toVersion: currentSqliteVersion(options.format), durationMs: Date.now() - started, outcome });
  try {
    source = runSqliteTransaction(db, "DEFERRED", () => {
      const observed = inspectSqlite(db, options.format, { allowEmpty: options.allowEmpty });
      // Keep the observed version available if ending the read snapshot fails.
      source = observed;
      return observed;
    });
    if (source.kind !== "current") { migrationId = randomUUID(); started = Date.now(); phase = "report"; report(event("started", "begin", "not-started")); }
    phase = "configure";
    if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") throw new Error("SQLite refused WAL mode.");
    db.pragma("synchronous = FULL");
    if (db.pragma("synchronous", { simple: true }) !== 2) throw new Error("SQLite refused synchronous=FULL.");
    phase = "transaction";
    const transition = runSqliteImmediate(db, () => {
      const fresh = inspectSqlite(db, options.format, { allowEmpty: options.allowEmpty });
      if (fresh.kind !== "current") { phase = "admission"; options.assertMigrationAllowed?.(db, fresh); }
      phase = "migrate"; const result = upgradeSqlite(db, options.format, { allowEmpty: options.allowEmpty });
      phase = "startup"; options.onReady?.(db);
      return result;
    });
    committed = true;
    if (migrationId !== undefined) { phase = "report"; report(event("completed", transition === null ? "already-current" : "commit", "committed", transition)); }
    return db;
  } catch (primary) {
    const outcome = committed ? "committed" : sqliteTransactionOutcome(primary);
    const transactionPhase = typeof primary === "object" && primary !== null ? phases.get(primary) : undefined;
    const failedPhase = transactionPhase === undefined || transactionPhase === "action" ? phase : transactionPhase;
    let closed = false, failure: unknown = primary;
    try { db.close(); closed = true; }
    catch (close) { failure = new AggregateError([primary, close], "SQLite operation and connection shutdown failed."); }
    const wrapped = wrap(options, failedPhase, failure, closed, phase === "inspect" && transactionPhase === undefined || phase === "configure" || phase === "report" && !committed ? "not-started" : outcome, source?.version);
    if (migrationId !== undefined) {
      try { report({ ...event("failed", failedPhase, wrapped.outcome), ...(wrapped.context.stepVersion === undefined ? {} : { stepVersion: wrapped.context.stepVersion }) }); }
      catch (reportError) { throw wrap(options, "report", new AggregateError([wrapped, reportError], "SQLite operation and failure reporting failed."), closed, wrapped.outcome, source?.version); }
    }
    if (phase === "startup" && transactionPhase === "action" && closed && failure === primary && primary instanceof Error && primary.constructor === Error && !(primary instanceof SqliteAccessError) && !("code" in primary && typeof primary.code === "string" && primary.code.startsWith("SQLITE_"))) throw primary;
    throw wrapped;
  }
};

type ReadAttempt<T> = { kind: "value"; value: T } | { kind: "upgrade" };
const readAttempt = <T>(options: ReadSqliteOptions<T>, read: (db: Database.Database) => T, allowUpgrade: boolean): ReadAttempt<T> => {
  let missing: boolean;
  try { missing = sqliteDatabaseIsMissing(options.file); }
  catch (cause) { throw wrap(options, "inspect-path", cause, true, "not-started"); }
  if (missing) return { kind: "value", value: options.onMissing() };
  let db: Database.Database;
  try { db = new Database(options.file, { readonly: true, fileMustExist: true, timeout: validateOptions(options) }); }
  catch (cause) {
    try { missing = sqliteDatabaseIsMissing(options.file); }
    catch (probe) { throw wrap(options, "open-read", new AggregateError([cause, probe], "SQLite open and missing-path verification failed."), true, "not-started"); }
    if (missing) return { kind: "value", value: options.onMissing() };
    throw wrap(options, "open-read", cause, true, "not-started");
  }
  let result: ReadAttempt<T> | undefined, failed = false, failure: unknown;
  try {
    result = db.transaction((): ReadAttempt<T> => {
      const source = inspectSqlite(db, options.format, { allowEmpty: false });
      if (source.kind !== "current") {
        if (allowUpgrade) return { kind: "upgrade" };
        throw new SqliteAccessError("invalid-format", context(options, "read-after-upgrade", source.version));
      }
      return { kind: "value", value: read(db) };
    }).deferred();
  } catch (cause) { failed = true; failure = cause; }
  try { db.close(); }
  catch (close) { throw wrap(options, "close", failed ? new AggregateError([failure, close], "SQLite read and connection shutdown failed.") : close, false, "not-started"); }
  if (failed) throw wrap(options, "read", failure, true, "not-started");
  return result!;
};
export const readSqliteDatabase = <T>(options: ReadSqliteOptions<T>, read: (db: Database.Database) => T): T => {
  validateOptions(options);
  const first = readAttempt(options, read, true);
  if (first.kind === "value") return first.value;
  let permit: MaintenancePermit | undefined;
  try { permit = options.acquireMaintenance?.(); }
  catch (blocked) {
    if (!(blocked instanceof MaintenanceLockHeldError)) throw wrap(options, "admission", blocked, false, "not-started");
    const second = readAttempt(options, read, true);
    if (second.kind === "value") return second.value;
    throw wrap(options, "admission", blocked, true, "not-started");
  }
  let db: Database.Database | undefined, closed = false, failed = false, failure: unknown, outcome: SqliteOutcome = "unknown";
  try {
    db = openSqliteDatabase({ file: options.file, format: options.format, allowEmpty: false, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }), ...(options.assertMigrationAllowed === undefined ? {} : { assertMigrationAllowed: options.assertMigrationAllowed }) });
    outcome = "committed"; closeSqliteDatabase(db, options, outcome); closed = true;
  } catch (cause) { failed = true; failure = cause; closed = cause instanceof SqliteAccessError && cause.connectionClosed; outcome = cause instanceof SqliteAccessError ? cause.outcome : "unknown"; }
  if (permit !== undefined && closed && outcome !== "unknown") {
    try { permit.release(); }
    catch (release) { throw wrap(options, "release", failed ? new AggregateError([failure, release], "SQLite migration and maintenance release failed.") : release, true, outcome); }
  }
  if (failed) {
    if (failure instanceof SqliteAccessError && failure.context.phase === "open" && failure.connectionClosed) {
      let missing: boolean;
      try { missing = sqliteDatabaseIsMissing(options.file); }
      catch (probe) { throw wrap(options, "inspect-path", new AggregateError([failure, probe], "SQLite migration open and missing-path verification failed."), true, "not-started"); }
      if (missing) return options.onMissing();
    }
    throw failure;
  }
  const final = readAttempt(options, read, false);
  if (final.kind !== "value") throw new Error("SQLite reader failed to produce a current snapshot.");
  return final.value;
};
