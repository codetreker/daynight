import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SqliteMigrationEvent } from "../../platform/sqlite-access.js";
import { serializeSqliteError, SqliteAccessError } from "../../platform/sqlite-error.js";
import type { TaskPlatform } from "../../api/types.js";
import type { WorkerPaths } from "./paths.js";
import type { LocalTask } from "./types.js";
import type { CleanupTarget } from "./execution-stop.js";

export type WorkerDiagnostic = { kind: string; message: string; projectId?: string; task?: LocalTask; identity?: CleanupTarget; component?: string; phase?: string; attemptId?: string; runKey?: string; error?: unknown; sqlite?: SqliteMigrationEvent };

const sqliteMetadata = (event: SqliteMigrationEvent): SqliteMigrationEvent => ({
  migrationId: event.migrationId, database: event.database, file: event.file,
  kind: event.kind, phase: event.phase, fromVersion: event.fromVersion, toVersion: event.toVersion,
  ...(event.stepVersion === undefined ? {} : { stepVersion: event.stepVersion }),
  durationMs: event.durationMs, outcome: event.outcome,
  ...(event.storage === undefined ? {} : { storage: event.storage }),
  ...(event.error === undefined ? {} : { error: event.error }),
});

export const workerSqliteMigrationEvent = (event: SqliteMigrationEvent): WorkerDiagnostic => ({
  kind: `sqlite-migration-${event.kind}`,
  message: `SQLite ${event.database} ${event.phase}: ${event.fromVersion} → ${event.toVersion} (${event.outcome}).`,
  sqlite: sqliteMetadata(event),
});

const abbreviateGuids = (value: string): string => value.replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "$1");

export const createWorkerDiagnostics = async (options: {
  paths: WorkerPaths; workerId: string; platform: TaskPlatform;
  log?: (message: string) => void; secrets?: readonly string[];
}) => {
  await mkdir(options.paths.logsDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(options.paths.logsDirectory, `worker-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const redact = (value: string): string => {
    let result = value;
    for (const secret of options.secrets === undefined ? [] : options.secrets) {
      if (secret.length !== 0) for (const representation of new Set([secret, encodeURIComponent(secret)])) result = result.replaceAll(representation, "[redacted]");
    }
    return result.replace(/\b(Bearer\s+)[^\s"']+/gi, "$1[redacted]").replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
  };
  const describeError = (value: unknown, depth = 0): unknown => {
    if (value instanceof SqliteAccessError) return serializeSqliteError(value);
    if (value instanceof Error) return {
      name: value.name, message: redact(value.message),
      ...(value.cause === undefined || depth >= 6 ? {} : { cause: describeError(value.cause, depth + 1) }),
      ...(value instanceof AggregateError && depth < 6 ? { errors: value.errors.map((error: unknown) => describeError(error, depth + 1)) } : {}),
    };
    return redact(String(value));
  };
  let pending = Promise.resolve();
  let failed: unknown;
  const emit = (event: WorkerDiagnostic): void => {
    const task = event.task;
    const identity = task ?? event.identity;
    const record = {
      timestamp: new Date().toISOString(), workerId: options.workerId, platform: options.platform,
      kind: event.kind, message: redact(event.message),
      ...(event.sqlite === undefined ? {} : { sqlite: sqliteMetadata(event.sqlite) }),
      ...(identity === undefined ? {} : { projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId }),
      ...(identity === undefined && event.projectId !== undefined ? { projectId: event.projectId } : {}),
      ...(event.identity?.worktreeId === undefined ? {} : { worktreeId: event.identity.worktreeId }),
      ...(task === undefined ? {} : { status: task.status, agent: task.agent, sessionId: task.sessionId }),
      ...(event.component === undefined ? {} : { component: event.component }),
      ...(event.phase === undefined ? {} : { phase: event.phase }),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      ...(event.runKey === undefined ? {} : { runKey: event.runKey }),
      ...(event.error === undefined ? {} : { error: describeError(event.error) }),
    };
    const serialized = JSON.stringify(record, (_key, value: unknown) => typeof value === "string" ? redact(value) : value);
    if (failed === undefined) pending = pending.then(() => appendFile(filename, `${serialized}\n`, { mode: 0o600 })).catch((cause: unknown) => { failed = cause; });
    try { options.log?.(abbreviateGuids(redact(`${record.timestamp} ${record.kind}${identity === undefined ? "" : ` ${identity.projectId}/${identity.taskId}/${identity.claimId}${task === undefined ? "" : ` ${task.status}`}`} ${record.message}${record.error === undefined ? "" : ` ${JSON.stringify(record.error)}`}\n`))); }
    catch (cause) { if (failed === undefined) failed = cause; }
  };
  return {
    emit,
    flush: async (): Promise<void> => { await pending; if (failed !== undefined) throw failed; },
    filename,
  };
};
