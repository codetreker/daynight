import { createOperation, type Operation } from "../../../api/operation.js";
import { createAssistantTaskClient } from "../../../api/assistant-task.js";
import type { CodexProbeOwner } from "../codex-probe-owner.js";
import type { WorkerEvent } from "../execution.js";
import { workerSqliteMigrationReporter } from "../diagnostics.js";
import type { WorkerPaths } from "../paths.js";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { botToolActivity } from "../tool-activity.js";
import type { ActiveToolSelection } from "../tool-selection.js";
import type { createWorkerToolInspector } from "../native-selection.js";
import type { FrozenToolObservation } from "../types.js";
import type { ExecutionConfiguration } from "../types.js";
import { createBotDeletion } from "./delete.js";
import { openLocalBotStores } from "./local-store.js";
import { createAssistantHostCollector, type AssistantHostSample } from "./host-capabilities.js";
import { createBotProcess } from "./process.js";
import { createBotRemote } from "./remote.js";
import { createManagedAssistantRuntime } from "./runtime.js";
import { createBotSessionApi } from "./session-api.js";
import type { BotOwner } from "./types.js";
import { createAssistantTaskRuntime } from "./assistant-tasks.js";
import { createAssistantTaskSessionTransport } from "./assistant-task-session.js";
import { prepareBotStateDirectory } from "./environment.js";
import { ControllerIpcOutcomeUnknownError } from "../../controller/local-client.js";
import { ASSISTANT_TASK_OPERATION_BYTES, ASSISTANT_TASK_RESPONSE_BYTES } from "./assistant-task-pages.js";
import { createWatchdogApplication } from "./apps/watchdog.js";
import { createWatchdogTransport } from "./apps/watchdog-transport.js";
import { openBotRecoveryStore } from "./recovery-store.js";
import { createBotRecoveryApi } from "./recovery-api.js";
import { createBotReconciliation } from "./reconciliation.js";
import { botStopDeadline, joinBotWork, type BotStopOptions } from "./stop-budget.js";

/** Storage locks remain held until all Bot jobs and writers have joined. */
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
  const migration = { onMigration: workerSqliteMigrationReporter(options.emit) };
  const local = openLocalBotStores({ stateDirectory: options.paths.stateDirectory, legacyDatabaseFile: options.paths.databaseFile, owner: options.owner, ...migration });
  const { store, executions } = local;
  try {
    let machineReportConfirmed = false;
    const remote = createBotRemote({ owner: options.owner, serverToken: options.serverToken });
    const recovery = createBotReconciliation({ owner: options.owner,
      store: openBotRecoveryStore({ stateDirectory: options.paths.stateDirectory, owner: options.owner, assertLocked: local.assertLocked }),
      api: createBotRecoveryApi({ owner: options.owner, serverToken: options.serverToken }), applicable: local.isDedicated,
      canSubmit: () => machineReportConfirmed });
    const sessionApi = createBotSessionApi({ owner: options.owner, serverToken: options.serverToken, recovery, stateDirectory: options.paths.stateDirectory });
    const botProcess = createBotProcess({ ...options, store, executions, sessionApi, reconcileHosting: local.isDedicated, canControl: recovery.ownsHosting, recoveryLimit: () => {
      const value = options.recoveryLimit();
      if (value === null) throw new Error("Worker recovery configuration has not been applied; Bot initialization is waiting.");
      return value;
    } });
    const deletion = createBotDeletion({ ...options, store, executions, process: botProcess, sessionApi, remote });
    const assistantTasks = createAssistantTaskRuntime({ owner: options.owner, bots: () => store.list(options.owner).filter(record => record.migration === undefined),
      stateDirectory: botId => prepareBotStateDirectory(options.paths, botId),
      healthy: async (record, signal) => {
        try {
          const snapshot = await botProcess.observe(record, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
          return recovery.ready(record) && snapshot.startup?.state === "ready" && ["ready", "working"].includes(snapshot.lifecycle) && !snapshot.nativeStopped && snapshot.error === null;
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
      sessions: createAssistantTaskSessionTransport({ owner: options.owner, serverToken: options.serverToken, sessionApi, canSend: recovery.ready }),
      onError: (message, botId) => options.emit({ kind: "bot-unavailable", message: botId === null ? message : `Bot ${botId}: ${message}` }),
    });
    assistantTasks.registerApplication("watchdog", createWatchdogApplication(createWatchdogTransport(options), {
      onError: error => options.emit({ kind: "bot-unavailable", message: error instanceof Error ? error.message : "Watchdog evaluation failed." }),
    }));
    const runtime = createManagedAssistantRuntime({ owner: options.owner, store, remote, sessionApi, process: botProcess, deletion,
      scanLocal: () => local.scan(),
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
    let closed = false, admissionClosed = false, shutdownConfirmed = false;
    const probeCancellation = new AbortController(), collections = new Set<Promise<AssistantHostSample>>();
    let shutdownFailure: unknown, shutdownFailed = false, shuttingDown: Promise<void> | null = null;
    const closeAdmission = (reason?: unknown): void => { admissionClosed = true; probeCancellation.abort(reason); runtime.closeAdmission(reason); };
    const shutdown = (settings?: BotStopOptions): Promise<void> => {
      closeAdmission();
      if (shutdownConfirmed) return Promise.resolve();
      if (shuttingDown !== null) return shuttingDown;
      // Explicit shutdown can re-observe a previous failure; close never retries
      // process control implicitly while releasing resources.
      const deadline = botStopDeadline(settings);
      const work = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([
          runtime.shutdown({ deadline }),
          (async () => {
            await joinBotWork(Promise.allSettled([...collections]), deadline, "Bot capability probes");
            await joinBotWork(collector.close(), deadline, "Bot capability probe cleanup");
          })(),
        ]);
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Bot jobs and capability probes could not stop.");
      }).then(() => {
        shutdownConfirmed = true; shutdownFailed = false; shutdownFailure = undefined;
      }, cause => { shutdownFailed = true; shutdownFailure = cause; throw cause; });
      shuttingDown = work.finally(() => { shuttingDown = null; });
      return shuttingDown;
    };
    return {
      run: runtime.run,
      closeAdmission,
      snapshot: () => ({ ...runtime.snapshot(), probes: collections.size, resources: store.list(options.owner).map(record => ({
        botId: record.botId, executionId: record.intent?.executionId ?? null,
        sessionId: record.intent?.sessionId ?? null, executionGeneration: record.intent?.executionGeneration ?? null,
      })) }),
      confirmMachineReport: (): void => { if (!closed) machineReportConfirmed = true; },
      shutdown,
      registerApplication: assistantTasks.registerApplication,
      requiresCopilot: (): boolean => store.list(options.owner).some(record => record.observed.deletion === null && record.definition?.resolvedConfiguration.provider === "copilot"),
      collect: async (operation: Operation, codexProbes?: CodexProbeOwner): Promise<AssistantHostSample | undefined> => {
        const current = options.configuration();
        if (closed || admissionClosed || current === null) return undefined;
        const collection = createOperation({ signal: AbortSignal.any([operation.signal, probeCancellation.signal]), limits: { ...operation.limits, totalMs: Math.max(1, Math.floor(operation.remainingMs())) } });
        const work = collector.collect(collection, codexProbes);
        collections.add(work);
        let sample: AssistantHostSample;
        try { sample = await work; } finally { collections.delete(work); collection.dispose(); }
        // A probe which crossed a configuration transition cannot advertise stale defaults.
        return !admissionClosed && JSON.stringify(current) === JSON.stringify(options.configuration()) ? sample : undefined;
      },
      activeToolSelections: (): ActiveToolSelection[] => store.list(options.owner).flatMap(record => {
        if (record.migration !== undefined) return [];
        const intent = record.intent, tool = record.definition?.resolvedConfiguration.provider;
        if (intent === null || tool !== "codex" && tool !== "copilot") return [];
        const execution = executions!.get(record);
        const activity = botToolActivity(record, execution); if (activity === "inactive") return [];
        const unknown = activity === "unconfirmed";
        return [{ tool, context: "web", launch: intent.toolLaunch ?? null, version: intent.toolObservation?.version ?? null, checkedAt: intent.toolObservation?.checkedAt ?? null, executionCount: unknown ? null : 1, instanceCount: 0, unconfirmedCount: unknown ? 1 : 0 }];
      }),
      close: async (): Promise<void> => {
        if (closed) return;
        const failures: unknown[] = [];
        try {
          if (shutdownFailed) throw shutdownFailure;
          await shutdown();
        }
        catch (error) { throw new AggregateError([...failures, error], "Bot shutdown is unconfirmed; process leases and storage locks are retained."); }
        try { await botProcess.close(); } catch (error) { throw new AggregateError([error], "Bot process resources remain owned; storage locks are retained."); }
        try { executions!.close(); } catch (error) { failures.push(error); }
        try { store.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "Bot stores could not close.");
        closed = true;
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
