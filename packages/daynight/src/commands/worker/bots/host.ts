import { createOperation, type Operation } from "../../../api/operation.js";
import { createAssistantTaskClient } from "../../../api/assistant-task.js";
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
import { createAssistantTaskRuntime } from "./assistant-tasks.js";
import { createAssistantTaskSessionTransport } from "./assistant-task-session.js";
import { prepareBotStateDirectory } from "./environment.js";
import { ControllerIpcOutcomeUnknownError } from "../../controller/local-client.js";
import { ASSISTANT_TASK_OPERATION_BYTES, ASSISTANT_TASK_RESPONSE_BYTES } from "./assistant-task-pages.js";

/** The Worker lock protects both stores until all Bot jobs and writers have joined. */
export const createWorkerBotHost = (options: {
  selectToolLaunch?: (agent: "codex" | "copilot", signal: AbortSignal) => Promise<ResolvedToolLaunch>;
  toolLaunchForHost?: (agent: "codex" | "copilot") => ResolvedToolLaunch | undefined;
  toolObservationFor?: (launch: ResolvedToolLaunch) => FrozenToolObservation | undefined;
  toolRuntimeRoot?: string;
  toolInspector?: ReturnType<typeof createWorkerToolInspector>;
  homeDirectory: string; packageDirectory: string; workingDirectory: string; paths: WorkerPaths;
  owner: BotOwner; serverToken: string; configuration(): ExecutionConfiguration | null;
  copilotRequired?: () => boolean;
  canAdmitNewExecution(): boolean;
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
    const assistantTasks = createAssistantTaskRuntime({ owner: options.owner, bots: () => store.list(options.owner),
      stateDirectory: botId => prepareBotStateDirectory(options.paths, botId),
      healthy: async (record, signal) => {
        try {
          const snapshot = await botProcess.observe(record, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
          return snapshot.startup?.state === "ready" && ["ready", "working"].includes(snapshot.lifecycle) && !snapshot.nativeStopped && snapshot.error === null;
        } catch (error) { signal.throwIfAborted(); if (error instanceof ControllerIpcOutcomeUnknownError) return false; throw error; }
      },
      idle: async (record, signal) => {
        const snapshot = await sessionApi.readSession(record, signal);
        return snapshot.synchronized && snapshot.connectionState === "connected" && snapshot.lifecycle === "active" && snapshot.activity === "idle" && snapshot.currentTurnId === null && snapshot.operations.canSend;
      },
      withApi: async (botId, signal, action) => {
        const operation = createOperation({ signal, limits: { totalMs: 45_000, requestMs: 10_000, responseBytes: ASSISTANT_TASK_RESPONSE_BYTES, totalBytes: ASSISTANT_TASK_OPERATION_BYTES } });
        try { return await action(createAssistantTaskClient({ serverUrl: options.owner.serverOrigin, serverToken: options.serverToken, expectedUserId: options.owner.ownerUserId, operation, ...(botId === undefined ? {} : { botId }) })); }
        finally { operation.dispose(); }
      },
      sessions: createAssistantTaskSessionTransport({ owner: options.owner, serverToken: options.serverToken, sessionApi }),
      onError: (message, botId) => options.emit({ kind: "bot-unavailable", message: botId === null ? message : `Bot ${botId}: ${message}` }),
    });
    const runtime = createManagedAssistantRuntime({ owner: options.owner, store, remote, sessionApi, process: botProcess, deletion,
      assistantTasks,
      canAdmitNewExecution: options.canAdmitNewExecution,
      pollIntervalMs: () => options.pollIntervalMs() ?? 1000,
      onError: (message, botId) => options.emit({ kind: "bot-unavailable", message: botId === null ? message : `Bot ${botId}: ${message}` }),
    });
    const configuration = (): ExecutionConfiguration => {
      const current = options.configuration();
      if (current === null) throw new Error("Worker native configuration has not been applied.");
      return current;
    };
    const collector = createAssistantHostCollector({ workingDirectory: options.workingDirectory, configuration,
      ...(options.copilotRequired === undefined ? {} : { copilotRequired: options.copilotRequired }),
      hasCopilotProof: () => {
        if (!options.toolLaunchForHost || !options.toolObservationFor || !options.toolInspector) return false;
        const launch = options.toolLaunchForHost("copilot");
        return launch?.tool === "copilot" && launch.context === "web" && options.toolObservationFor(launch) !== undefined;
      },
      ...(options.toolRuntimeRoot === undefined ? {} : { toolRuntimeRoot: options.toolRuntimeRoot }),
      ...(options.toolInspector === undefined ? {} : { toolInspector: options.toolInspector }),
      ...(options.toolLaunchForHost === undefined ? {} : { selectToolLaunch: async provider => provider === "claude" ? undefined : options.toolLaunchForHost!(provider) }),
      environment: { ...process.env, DN_CONFIG_DIR: options.paths.stateDirectory } });
    let closed = false;
    return {
      run: runtime.run,
      shutdown: runtime.shutdown,
      registerApplication: assistantTasks.registerApplication,
      requiresCopilot: (): boolean => store.list(options.owner).some(record => record.observed.deletion === null && record.definition?.resolvedConfiguration.provider === "copilot"),
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
