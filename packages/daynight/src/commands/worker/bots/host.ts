import type { Operation } from "../../../api/operation.js";
import type { CodexProbeOwner } from "../codex-probe-owner.js";
import type { WorkerEvent } from "../execution.js";
import { workerSqliteMigrationEvent } from "../diagnostics.js";
import type { WorkerPaths } from "../paths.js";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { botToolActivity } from "../tool-activity.js";
import type { ActiveToolSelection } from "../tool-selection.js";
import type { createWorkerToolInspector } from "../native-selection.js";
import type { FrozenToolObservation } from "../types.js";
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
  selectToolLaunch?: (agent: "codex" | "copilot", signal: AbortSignal) => Promise<ResolvedToolLaunch>;
  toolLaunchForHost?: (agent: "codex" | "copilot") => ResolvedToolLaunch | undefined;
  toolObservationFor?: (launch: ResolvedToolLaunch) => FrozenToolObservation | undefined;
  toolRuntimeRoot?: string;
  toolInspector?: ReturnType<typeof createWorkerToolInspector>;
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
      ...(options.toolRuntimeRoot === undefined ? {} : { toolRuntimeRoot: options.toolRuntimeRoot }),
      ...(options.toolInspector === undefined ? {} : { toolInspector: options.toolInspector }),
      ...(options.toolLaunchForHost === undefined ? {} : { selectToolLaunch: async provider => provider === "claude" ? undefined : options.toolLaunchForHost!(provider) }),
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
      activeToolSelections: (): ActiveToolSelection[] => store.list(options.owner).flatMap(record => {
        const intent = record.intent, tool = record.definition?.resolvedConfiguration.provider;
        if (intent === null || tool !== "codex" && tool !== "copilot") return [];
        const execution = executions!.get(record);
        const activity = botToolActivity(record, execution); if (activity === "inactive") return [];
        const unknown = activity === "unconfirmed";
        return [{ tool, context: "web", launch: intent.toolLaunch ?? null, version: intent.toolObservation?.version ?? null, checkedAt: intent.toolObservation?.checkedAt ?? null, executionCount: unknown ? null : 1, instanceCount: 0, unconfirmedCount: unknown ? 1 : 0 }];
      }),
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try { await collector.close(); } catch (error) { failures.push(error); }
        try { await botProcess.close(); } catch (error) { failures.push(error); }
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
