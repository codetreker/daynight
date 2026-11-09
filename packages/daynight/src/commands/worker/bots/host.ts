import type { Operation } from "../../../api/operation.js";
import type { CodexProbeOwner } from "../codex-probe-owner.js";
import type { WorkerEvent } from "../execution.js";
import { workerSqliteMigrationEvent } from "../diagnostics.js";
import type { WorkerPaths } from "../paths.js";
import type { ExecutionConfiguration } from "../types.js";
import { createBotDeletion } from "./delete.js";
import { openBotExecutionStore } from "./execution-store.js";
import { createAssistantHostCollector, type AssistantHostSample } from "./host-capabilities.js";
import { createBotProcess } from "./process.js";
import { createBotRemote } from "./remote.js";
import { createManagedAssistantRuntime } from "./runtime.js";
import { createBotSessionApi } from "./session-api.js";
import { openBotStore } from "./store.js";
import type { BotOwner } from "./types.js";

/** The Worker lock protects both stores until all Bot jobs and writers have joined. */
export const createWorkerBotHost = (options: {
  homeDirectory: string; packageDirectory: string; workingDirectory: string; paths: WorkerPaths;
  owner: BotOwner; serverToken: string; configuration(): ExecutionConfiguration | null;
  pollIntervalMs(): number | null; recoveryLimit(): number | null; emit(event: WorkerEvent): void;
}) => {
  const migration = { onMigration: (event: Parameters<typeof workerSqliteMigrationEvent>[0]): undefined => { options.emit(workerSqliteMigrationEvent(event)); } };
  const store = openBotStore(options.paths.databaseFile, migration);
  let executions: ReturnType<typeof openBotExecutionStore> | undefined;
  try {
    executions = openBotExecutionStore(options.paths.databaseFile, migration);
    const remote = createBotRemote({ owner: options.owner, serverToken: options.serverToken });
    const sessionApi = createBotSessionApi({ owner: options.owner, serverToken: options.serverToken });
    const botProcess = createBotProcess({ ...options, store, executions, sessionApi, recoveryLimit: () => {
      const value = options.recoveryLimit();
      if (value === null) throw new Error("Worker recovery configuration has not been applied; Bot initialization is waiting.");
      return value;
    } });
    const deletion = createBotDeletion({ ...options, store, executions, process: botProcess, sessionApi, remote });
    const runtime = createManagedAssistantRuntime({ owner: options.owner, store, remote, sessionApi, process: botProcess, deletion,
      pollIntervalMs: () => options.pollIntervalMs() ?? 1000,
      onError: (message, botId) => options.emit({ kind: "bot-unavailable", message: botId === null ? message : `Bot ${botId}: ${message}` }),
    });
    const configuration = (): ExecutionConfiguration => {
      const current = options.configuration();
      if (current === null) throw new Error("Worker native configuration has not been applied.");
      return current;
    };
    const collector = createAssistantHostCollector({ workingDirectory: options.workingDirectory, configuration,
      environment: { ...process.env, DN_CONFIG_DIR: options.paths.stateDirectory } });
    let closed = false;
    return {
      run: runtime.run,
      shutdown: runtime.shutdown,
      collect: async (operation: Operation, codexProbes?: CodexProbeOwner): Promise<AssistantHostSample | undefined> => {
        const current = options.configuration();
        if (closed || current === null) return undefined;
        const sample = await collector.collect(operation, codexProbes);
        // A probe which crossed a configuration transition cannot advertise stale defaults.
        return JSON.stringify(current) === JSON.stringify(options.configuration()) ? sample : undefined;
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try { executions!.close(); } catch (error) { failures.push(error); }
        try { store.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "Bot stores could not close.");
      },
    };
  } catch (error) {
    const failures = [error];
    try { executions?.close(); } catch (failure) { failures.push(failure); }
    try { store.close(); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "Bot host initialization and store cleanup failed.");
    throw error;
  }
};
export type WorkerBotHost = ReturnType<typeof createWorkerBotHost>;
