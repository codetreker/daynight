import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TaskPlatform } from "../../api/types.js";
import type { WorkerPaths } from "./paths.js";
import type { LocalTask } from "./types.js";

export type WorkerDiagnostic = { kind: string; message: string; task?: LocalTask; error?: unknown };

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
    const record = {
      timestamp: new Date().toISOString(), workerId: options.workerId, platform: options.platform,
      kind: event.kind, message: redact(event.message),
      ...(task === undefined ? {} : {
        projectId: task.projectId, taskId: task.taskId, claimId: task.claimId,
        status: task.status, agent: task.agent, sessionId: task.sessionId,
      }),
      ...(event.error === undefined ? {} : { error: describeError(event.error) }),
    };
    const serialized = JSON.stringify(record, (_key, value: unknown) => typeof value === "string" ? redact(value) : value);
    if (failed === undefined) pending = pending.then(() => appendFile(filename, `${serialized}\n`, { mode: 0o600 })).catch((cause: unknown) => { failed = cause; });
    try { options.log?.(`${record.timestamp} ${record.kind}${task === undefined ? "" : ` ${task.projectId}/${task.taskId}/${task.claimId} ${task.status}`} ${record.message}${event.error === undefined ? "" : ` ${JSON.stringify(describeError(event.error))}`}\n`); }
    catch (cause) { if (failed === undefined) failed = cause; }
  };
  return {
    emit,
    flush: async (): Promise<void> => { await pending; if (failed !== undefined) throw failed; },
    filename,
  };
};
