import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import path from "node:path";
import type { SqliteMigrationEvent } from "../../platform/sqlite-access.js";
import { serializeSqliteError, SqliteAccessError } from "../../platform/sqlite-error.js";
import type { TaskPlatform } from "../../api/types.js";
import type { WorkerPaths } from "./paths.js";
import type { LocalTask } from "./types.js";
import type { CleanupTarget } from "./execution-stop.js";

export type WorkerDiagnostic = { kind: string; message: string; projectId?: string; task?: LocalTask; identity?: CleanupTarget; component?: string; phase?: string; attemptId?: string; runKey?: string; error?: unknown; sqlite?: SqliteMigrationEvent; sink?: WorkerDiagnosticSinkMetadata };

const sqliteMetadata = (event: SqliteMigrationEvent): SqliteMigrationEvent => ({
  migrationId: event.migrationId, database: event.database, file: event.file,
  kind: event.kind, phase: event.phase, fromVersion: event.fromVersion, toVersion: event.toVersion,
  ...(event.stepVersion === undefined ? {} : { stepVersion: event.stepVersion }),
  durationMs: event.durationMs, outcome: event.outcome,
});

export const workerSqliteMigrationEvent = (event: SqliteMigrationEvent): WorkerDiagnostic => ({
  kind: `sqlite-migration-${event.kind}`,
  message: `SQLite ${event.database} ${event.phase}: ${event.fromVersion} → ${event.toVersion} (${event.outcome}).`,
  sqlite: sqliteMetadata(event),
});

const abbreviateGuids = (value: string): string => value.replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "$1");

export type WorkerDiagnosticSinkMetadata = {
  filename: string; previousFilename: string | null; omittedRecords: number; unknownAppends: number; nextAttemptAt: string | null;
};
export type WorkerDiagnosticSinkEvent = WorkerDiagnosticSinkMetadata & {
  state: "blocked" | "recovered"; phase: "directory" | "segment" | "append"; error?: unknown;
};
export type WorkerDiagnosticFiles = {
  ensureDirectory(directory: string): Promise<void>;
  createSegment(filename: string): Promise<void>;
  appendRecord(filename: string, record: string): Promise<void>;
};

const fileOperations: WorkerDiagnosticFiles = {
  ensureDirectory: async directory => { await mkdir(directory, { recursive: true, mode: 0o700 }); },
  createSegment: async filename => { await appendFile(filename, "", { flag: "ax", mode: 0o600 }); },
  appendRecord: async (filename, record) => { await appendFile(filename, record, { mode: 0o600 }); },
};
const retryDelays = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
type RetryStep = 0 | 1 | 2 | 3 | 4;
const maximumQueuedRecords = 256;
const fileIoFailure = (error: unknown): boolean => {
  if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return false;
  if (error instanceof AggregateError) return error.errors.length !== 0 && error.errors.every(fileIoFailure);
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && (Object.hasOwn(constants.errno, code) || code === "UNKNOWN" && "errno" in error && typeof error.errno === "number" && "syscall" in error && typeof error.syscall === "string");
};
const sinkMetadata = (event: WorkerDiagnosticSinkMetadata): WorkerDiagnosticSinkMetadata => ({
  filename: event.filename, previousFilename: event.previousFilename, omittedRecords: event.omittedRecords,
  unknownAppends: event.unknownAppends, nextAttemptAt: event.nextAttemptAt,
});

export const createWorkerDiagnostics = async (options: {
  paths: WorkerPaths; workerId: string; platform: TaskPlatform;
  log?: (message: string) => void; secrets?: readonly string[];
  onSinkState?: (event: WorkerDiagnosticSinkEvent) => void;
  now?: () => number; stderr?: (message: string) => void | Promise<void>; files?: WorkerDiagnosticFiles;
}) => {
  const now = options.now ?? Date.now, files = options.files ?? fileOperations;
  // Run IDs avoid GUID-shaped text so foreground abbreviation preserves log paths.
  const family = "worker-" + new Date(now()).toISOString().slice(0, 10) + "-" + randomUUID().replaceAll("-", "");
  let segment = 0, filename = path.join(options.paths.logsDirectory, family + "-0.jsonl");
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
  const serialize = (event: WorkerDiagnostic) => {
    const task = event.task, identity = task ?? event.identity;
    const record = {
      timestamp: new Date(now()).toISOString(), workerId: options.workerId, platform: options.platform,
      kind: event.kind, message: redact(event.message),
      ...(event.sqlite === undefined ? {} : { sqlite: sqliteMetadata(event.sqlite) }),
      ...(event.sink === undefined ? {} : { sink: sinkMetadata(event.sink) }),
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
    const line = JSON.stringify(record, (_key, value: unknown) => typeof value === "string" ? redact(value) : value) + "\n";
    const reference = identity === undefined ? "" : " " + identity.projectId + "/" + identity.taskId + "/" + identity.claimId + (task === undefined ? "" : " " + task.status);
    const foreground = abbreviateGuids(redact(record.timestamp + " " + record.kind + reference + " " + record.message + (record.error === undefined ? "" : " " + JSON.stringify(record.error)) + "\n"));
    return { line, foreground };
  };
  let fatal: { error: unknown } | undefined, closing = false, closed = false;
  let pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  let omittedRecords = 0, unknownAppends = 0;
  const queue: string[] = [];
  let blocked: { error: unknown; phase: WorkerDiagnosticSinkEvent["phase"]; firstFilename: string; step: RetryStep; nextAttemptAt: number } | undefined;
  const stderrListeners = new Set<(error: Error) => void>();
  const stderr = options.stderr ?? ((message: string): Promise<void> => new Promise((resolve, reject) => {
    if (process.stderr.destroyed) {
      const cause = process.stderr.errored;
      reject(new Error("Worker diagnostic stderr is closed.", cause === null ? undefined : { cause }));
      return;
    }
    let callbackFailure: Error | undefined;
    const onError = (error: Error): void => {
      stderrListeners.delete(onError);
      reject(callbackFailure === undefined || callbackFailure === error ? error : new AggregateError([callbackFailure, error], "Worker diagnostic stderr failed."));
    };
    stderrListeners.add(onError); process.stderr.once("error", onError);
    const remove = (): void => { stderrListeners.delete(onError); process.stderr.removeListener("error", onError); };
    // The write callback precedes the error event; join both before removing its listener.
    // https://nodejs.org/download/release/v24.19.0/docs/api/stream.html#writablewritechunk-encoding-callback
    try { process.stderr.write(message, error => { if (error) callbackFailure = error; else { remove(); resolve(); } }); }
    catch (error) { remove(); reject(error); }
  }));
  const cancelTimer = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const fail = (error: unknown): void => {
    cancelTimer();
    if (fatal === undefined) fatal = { error };
    else if (fatal.error !== error) fatal = { error: new AggregateError([fatal.error, error], "Worker diagnostic output failed.", { cause: fatal.error }) };
  };
  const foreground = (value: string, primary?: unknown): void => {
    try { options.log?.(value); }
    catch (error) { fail(primary === undefined ? error : new AggregateError([primary, error], "Worker diagnostic file failure could not be written to foreground output.", { cause: primary })); }
  };
  const metadata = (): WorkerDiagnosticSinkMetadata => ({
    filename, previousFilename: blocked === undefined || blocked.firstFilename === filename ? null : blocked.firstFilename,
    omittedRecords, unknownAppends, nextAttemptAt: blocked === undefined || closing ? null : new Date(blocked.nextAttemptAt).toISOString(),
  });
  const notify = (event: WorkerDiagnosticSinkEvent): void => {
    try { options.onSinkState?.(Object.freeze(event)); }
    catch (error) { fail(event.error === undefined ? error : new AggregateError([event.error, error], "Worker diagnostic file failure notification failed.", { cause: event.error })); }
  };
  const report = async (event: WorkerDiagnostic): Promise<void> => {
    let output: ReturnType<typeof serialize>;
    try { output = serialize(event); }
    catch (error) {
      fail(event.error === undefined ? error : new AggregateError([event.error, error], "Worker diagnostic file failure could not be formatted.", { cause: event.error }));
      return;
    }
    foreground(output.foreground, event.error);
    try { await stderr(output.line); }
    catch (error) { fail(event.error === undefined ? error : new AggregateError([event.error, error], "Worker diagnostic failure could not be written to stderr.", { cause: event.error })); }
  };
  const block = async (phase: WorkerDiagnosticSinkEvent["phase"], error: unknown): Promise<void> => {
    const step = blocked?.step ?? 0, firstFilename = blocked?.firstFilename ?? filename;
    omittedRecords += queue.length; queue.length = 0;
    blocked = { error, phase, firstFilename, step: step === 4 ? 4 : (step + 1) as RetryStep, nextAttemptAt: now() + retryDelays[step] };
    const event: WorkerDiagnosticSinkEvent = { state: "blocked", phase, error, ...metadata() };
    notify(event);
    await report({ kind: "diagnostic-sink-blocked", component: "diagnostics", phase, message: "Worker diagnostic file sink is unavailable; recovery remains scheduled.", error, sink: event });
  };
  const prepare = async (): Promise<boolean> => {
    try { await files.ensureDirectory(options.paths.logsDirectory); }
    catch (error) { if (!fileIoFailure(error)) throw error; await block("directory", error); return false; }
    try { await files.createSegment(filename); }
    catch (error) { if (!fileIoFailure(error)) throw error; await block("segment", error); return false; }
    return true;
  };
  const append = async (line: string): Promise<boolean> => {
    try { await files.appendRecord(filename, line); return true; }
    catch (error) { if (!fileIoFailure(error)) throw error; unknownAppends++; await block("append", error); return false; }
  };
  const recover = async (): Promise<void> => {
    const previous = blocked!;
    filename = path.join(options.paths.logsDirectory, family + "-" + ++segment + ".jsonl");
    if (!await prepare()) return;
    const event: WorkerDiagnosticSinkEvent = { state: "recovered", phase: previous.phase, ...metadata(), nextAttemptAt: null };
    const output = serialize({ kind: "diagnostic-sink-recovered", component: "diagnostics", phase: previous.phase, message: "Worker diagnostic file sink recovered in a new segment; unknown appends were not replayed.", sink: event });
    if (!await append(output.line)) return;
    omittedRecords -= event.omittedRecords; unknownAppends -= event.unknownAppends;
    blocked = undefined;
    foreground(output.foreground); notify(event);
  };
  const schedule = (): void => {
    if (blocked === undefined || closing || fatal !== undefined || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; start(); }, Math.max(0, blocked.nextAttemptAt - now()));
    timer.unref();
  };
  const start = (): void => {
    if (pending !== undefined || closed || fatal !== undefined) return;
    if (blocked === undefined && queue.length === 0 && omittedRecords === 0) return;
    if (blocked !== undefined && (closing || blocked.nextAttemptAt > now())) { schedule(); return; }
    cancelTimer();
    pending = (async () => {
      if (blocked !== undefined) await recover();
      if (blocked !== undefined || fatal !== undefined) return;
      while (queue.length !== 0) if (!await append(queue.shift()!)) return;
      if (omittedRecords !== 0) {
        const event = metadata(), output = serialize({ kind: "diagnostic-sink-records-omitted", component: "diagnostics", phase: "append", message: "Diagnostic records were omitted before file dispatch.", sink: event });
        if (await append(output.line)) { omittedRecords -= event.omittedRecords; foreground(output.foreground); }
      }
    })().catch(fail).finally(() => { pending = undefined; if (blocked !== undefined) schedule(); else if (queue.length !== 0 || omittedRecords !== 0) start(); });
  };
  const emit = (event: WorkerDiagnostic): void => {
    if (closing) throw new Error("Worker diagnostic sink is closed.");
    try {
      const output = serialize(event);
      if (blocked !== undefined || fatal !== undefined || queue.length >= maximumQueuedRecords) omittedRecords++;
      else { queue.push(output.line); start(); }
      foreground(output.foreground);
    } catch (error) { fail(error); }
  };
  const flush = async (): Promise<void> => {
    for (;;) {
      start();
      const work = pending;
      if (work === undefined) break;
      await work;
    }
    if (fatal !== undefined) throw fatal.error;
  };
  await prepare();
  schedule();
  return {
    emit, flush,
    get filename(): string { return filename; },
    close: (): Promise<void> => stopping ??= (async () => {
      closing = true; cancelTimer();
      try {
        await flush();
        if (blocked !== undefined) await report({ kind: "diagnostic-sink-unavailable-at-close", component: "diagnostics", phase: blocked.phase, message: "Worker diagnostic file sink closed with omitted or unconfirmed records.", error: blocked.error, sink: metadata() });
      } finally {
        closed = true;
        for (const listener of stderrListeners) process.stderr.removeListener("error", listener);
        stderrListeners.clear();
      }
      if (fatal !== undefined) throw fatal.error;
    })(),
  };
};
