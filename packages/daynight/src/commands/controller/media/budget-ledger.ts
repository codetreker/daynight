import Database from "better-sqlite3";
import { chmodSync, lstatSync, mkdirSync, existsSync, openSync, closeSync, fsyncSync, constants } from "node:fs";
import path from "node:path";

/** Reservations survive crashes; stale process identity never releases retained media. */
export type MediaBudgetLedger = { reserve(bytes: number): void; close(): void };
export const openMediaBudgetLedger = (stateDirectory: string, executionId: string): MediaBudgetLedger => {
  const directory = path.join(stateDirectory, "controller", "media");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Controller media ledger directory must be private.");
  const file = path.join(directory, "budget.sqlite");
  const db = new Database(file); chmodSync(file, 0o600);
  try {
    db.pragma("busy_timeout = 5000"); db.pragma("synchronous = FULL");
    // Changing journal_mode races with another process's first reservation and
    // may return SQLITE_BUSY without honoring busy_timeout. Reserve using the
    // existing durable journal mode and serialize schema creation as a writer.
    db.transaction(() => db.exec("CREATE TABLE IF NOT EXISTS allocations(execution_id TEXT PRIMARY KEY,reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0))")).immediate();
  } catch (error) { db.close(); throw error; }
  const reserve = db.transaction((bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2_306_867_200) throw new Error("Controller execution media budget exceeded.");
    const other = (db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM allocations WHERE execution_id<>?").get(executionId) as { bytes: number }).bytes;
    if (other + bytes > 8_589_934_592) throw new Error("Controller stateDirectory media budget exceeded.");
    db.prepare("INSERT INTO allocations VALUES(?,?) ON CONFLICT(execution_id) DO UPDATE SET reserved_bytes=excluded.reserved_bytes").run(executionId, bytes);
  });
  return { reserve: (bytes: number) => reserve.immediate(bytes), close: () => db.close() };
};

/** Only the proven final sweep may retire an execution's durable reservation. */
export const releaseControllerMediaBudget = (stateDirectory: string, executionId: string, executionDirectory: string): void => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(executionId) || !path.isAbsolute(stateDirectory) || path.resolve(stateDirectory, "controller", "executions", executionId) !== executionDirectory) throw new Error("Media budget release requires the original execution directory.");
  try { lstatSync(executionDirectory); throw new Error("Controller media budget remains reserved until the complete execution source is removed."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const file = path.join(stateDirectory, "controller", "media", "budget.sqlite");
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Controller media ledger is not a private regular file.");
  if (process.platform !== "win32") {
    const fd = openSync(path.dirname(executionDirectory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma("synchronous = FULL"); db.pragma("busy_timeout = 5000");
    db.transaction(() => db.prepare("DELETE FROM allocations WHERE execution_id=?").run(executionId)).immediate();
  } finally { db.close(); }
};
