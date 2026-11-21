import { setTimeout as delay } from "node:timers/promises";
import { createOperation, type Operation } from "../../api/operation.js";
import type { WorkerReport, WorkerReportReceipt, WorkerMachine, TaskPlatform } from "../../api/types.js";

/** An idle management root can report its connection without running native probes. */
export const runLifecycleHeartbeat = async (options: {
  signal: AbortSignal; machine: WorkerMachine; platform: TaskPlatform; workingDirectory: string; version: string;
  executionReporterActive(): boolean;
  send(report: WorkerReport, operation: Operation): Promise<WorkerReportReceipt>;
  reportError(error: unknown): void;
}): Promise<void> => {
  while (!options.signal.aborted) {
    if (!options.executionReporterActive()) {
      const operation = createOperation({ signal: options.signal, limits: { totalMs: 10_000, requestMs: 10_000 } });
      try {
        const sampledAt = new Date().toISOString();
        const unavailable = { state: "error" as const, checkedAt: sampledAt, code: "unavailable" as const };
        await options.send({ machine: options.machine, platform: options.platform, workingDirectory: options.workingDirectory,
          sampledAt, os: unavailable, cpu: unavailable, memory: unavailable, disk: unavailable,
          versions: { daynight: options.version, codex: unavailable, copilot: unavailable }, taskInventory: null }, operation);
      } catch (error) { if (!options.signal.aborted) options.reportError(error); }
      finally { operation.dispose(); }
    }
    try { await delay(30_000, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
};
