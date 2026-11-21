import { setTimeout as delay } from "node:timers/promises";
import { createOperation, type Operation } from "../../api/operation.js";
import type { WorkerReport, WorkerReportReceipt, WorkerMachine, TaskPlatform } from "../../api/types.js";

type LifecycleHeartbeatOptions = {
  signal: AbortSignal; machine: WorkerMachine; platform: TaskPlatform; workingDirectory: string; version: string;
  executionReporterActive(): boolean;
  send(report: WorkerReport, operation: Operation): Promise<WorkerReportReceipt>;
  reportError(error: unknown): void;
};

/** A successful report establishes the Worker row before lifecycle registration. */
export const reportLifecycleHeartbeat = async (options: Omit<LifecycleHeartbeatOptions, "executionReporterActive" | "reportError">): Promise<WorkerReportReceipt> => {
  const operation = createOperation({ signal: options.signal, limits: { totalMs: 10_000, requestMs: 10_000 } });
  try {
    const sampledAt = new Date().toISOString();
    const unavailable = { state: "error" as const, checkedAt: sampledAt, code: "unavailable" as const };
    return await options.send({ machine: options.machine, platform: options.platform, workingDirectory: options.workingDirectory,
      sampledAt, os: unavailable, cpu: unavailable, memory: unavailable, disk: unavailable,
      versions: { daynight: options.version, codex: unavailable, copilot: unavailable }, taskInventory: null }, operation);
  } finally { operation.dispose(); }
};

/** An idle management root can report its connection without running native probes. */
export const runLifecycleHeartbeat = async (options: LifecycleHeartbeatOptions): Promise<void> => {
  while (!options.signal.aborted) {
    if (!options.executionReporterActive()) {
      try { await reportLifecycleHeartbeat(options); }
      catch (error) { if (!options.signal.aborted) options.reportError(error); }
    }
    try { await delay(30_000, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
};
