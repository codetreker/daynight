import { readLegacyLifecycleVersion } from "./backends/legacy-retired-evidence.js";
import Database from "better-sqlite3";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { sqliteFilename } from "../../platform/sqlite-filename.js";
import type { WorkerPaths } from "./paths.js";
import { inspectSqlite, type SqliteFormat } from "../../platform/sqlite-format.js";
import { workerStoreFormat } from "./store-format.js";
import { webExecutionStoreFormat } from "./backends/web-store-format.js";

const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const metadata = async (file: string) => {
  try { return await lstat(file); }
  catch (error) { if (missing(error)) return undefined; throw error; }
};

const hasOriginalRow = async (file: string, table: string, query: string, deadline: number, format?: SqliteFormat): Promise<boolean> => {
  const initial = await metadata(file);
  const sidecars = await Promise.all(["-wal", "-journal", "-shm"].map(suffix => metadata(file + suffix)));
  if (sidecars.some(value => value !== undefined && !value.isFile()) || initial !== undefined && !initial.isFile()) throw new Error("The original Worker database path is invalid.");
  if ((initial === undefined || initial.size === 0) && sidecars.every(value => value === undefined)) return false;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Original Worker inventory observation exceeded its deadline.");
  const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true, timeout: Math.min(1000, remaining) });
  try {
    return db.transaction(() => {
      if (format !== undefined) {
        const observed = inspectSqlite(db, format);
        if (observed.kind === "empty") return false;
        if (observed.kind === "unversioned") throw new Error("The original Worker database has an unidentified execution inventory.");
      } else readLegacyLifecycleVersion(db);
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) === undefined) {
        throw new Error("The original Worker database cannot establish its execution inventory.");
      }
      return db.prepare(query).get() !== undefined;
    }).deferred();
  } finally { db.close(); }
};

/** With no authenticated process owner, saved local state can only establish that stop is unresolved. */
export const assertNoUnobservedExecutions = async (paths: WorkerPaths, kind: "task" | "bot", deadline: number): Promise<void> => {
  const unresolved = () => new Error(`Original ${kind === "task" ? "Task" : "Bot"} resources remain unconfirmed because the Worker could not initialize their owner. Restore service access and reconcile the original execution.`);
  const legacy = path.join(paths.workerDirectory, "lifecycle.sqlite");
  const legacyKinds = kind === "task" ? "'task','controller'" : "'bot','controller'";
  if (await hasOriginalRow(legacy, "resource_owners", `SELECT 1 FROM resource_owners WHERE owner_kind IN (${legacyKinds})
    AND NOT (save_state IS 'durable' AND (stage IS 'stopped' OR stage IS 'not_dispatched' OR stage IS 'confirmed')) LIMIT 1`, deadline)) throw unresolved();
  if (kind === "task") {
    if (await hasOriginalRow(paths.databaseFile, "tasks", `SELECT 1 FROM tasks WHERE status <> 'done'
        UNION ALL SELECT 1 FROM cleanup_schedules UNION ALL SELECT 1 FROM claim_tool_reservations LIMIT 1`, deadline, workerStoreFormat)
      || await hasOriginalRow(path.join(paths.workerDirectory, "web-executions.sqlite"), "executions", "SELECT 1 FROM executions WHERE json_extract(data,'$.status') IS NOT 'done' LIMIT 1", deadline, webExecutionStoreFormat)) throw unresolved();
    return;
  }
  if (await hasOriginalRow(paths.databaseFile, "bots", "SELECT 1 FROM bots UNION ALL SELECT 1 FROM bot_executions LIMIT 1", deadline, workerStoreFormat)) throw unresolved();
  const directory = path.join(paths.stateDirectory, "bots");
  const info = await metadata(directory);
  if (info === undefined) return;
  if (!info.isDirectory() || Date.now() >= deadline) throw unresolved();
  const entries = await opendir(directory);
  try { if (await entries.read() !== null) throw unresolved(); }
  finally { await entries.close(); }
};
