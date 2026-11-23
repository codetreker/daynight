import { reconcileReviewerHostFailure, runReviewerHost } from "./reviewer-host.js";
import { createWebArchiveMaintenance } from "./web-archive-backfill.js";
import { replayStoppedControllerUsage } from "../controller/usage/stopped.js";
import { probeStoppedControllerArchive, uploadStoppedControllerArchive } from "../controller/archive-upload.js";
import { readLaunchTicket, controllerExecutionDirectory } from "../controller/launch-ticket.js";
import { prepareAgentCliAliases } from "../../cli/agent-cli-aliases.js";
import { readAgentCliAliases } from "../../config/agent-cli-aliases.js";
import { loadServerConfiguration } from "../../config/server.js";
import path from "node:path";
import { maintainWorkerControllerGrants } from "./backends/grant-renewal.js";
import { openWebExecutionStore } from "./backends/web-store.js";
import { createWebExecutionBackend } from "./backends/web.js";
import { createWebControllerLauncher } from "./backends/web-process.js";
import { createControllerJobLeases } from "./backends/controller-job-leases.js";
import { createRetiredClaimNativeCleanup } from "./backends/retired-claim-native.js";
import { createWorkerSessionApi } from "./backends/session-api.js";
import type { WorkerEvent } from "./execution.js";
import type { WorkerPaths } from "./paths.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createReconcileWake } from "./reconcile-wake.js";
import { createOperation, OperationError } from "../../api/operation.js";
import { cleanupOperation } from "../cleanup-operation.js";
import type { Operation } from "../../api/operation.js";
import { repositoryLocation, resolveRepositoryRoot } from "../../repository/location.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { ApiError } from "../../api/client.js";
import { ProtocolError } from "../../api/parse.js";
import type { WorkerCloudNative, ReceivedWorkerConfigurationResource } from "../../api/worker-configuration.js";
import { probeNativeAgentVersion } from "./native-version.js";
import { createWorkerConfigurationManager, resolveWorkerCloudProjectNative } from "./configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationSnapshot } from "./configuration.js";
import { readWorkerLocalConfiguration, resolveCloudNative, workerLocalExplicitProjectIds, workerLocalRepositoryForId, workerLocalRepositoryForProject, workerLocalUnboundRepository, workerLocalUnboundRepositoryIndexes } from "./configuration-source.js";
import type { ClaimIdentity, WorkerProject } from "./types.js";
import type { Task, TaskPlatform, WorkerMachine } from "../../api/types.js";
import { validateWorkerConfigurationSource, validateWorkerRepositoryLocations, workerConfigurationDefaults } from "./config.js";
import { createWorkerCoordinator } from "./coordinator.js";
import { createMonitoringObserver } from "./monitoring/observer.js";
import { createMonitoringSender } from "./monitoring/sender.js";
import type { WorkerCoordinatorConfiguration, WorkerRepositoryAssignment } from "./coordinator.js";
import { submitWorkerControl } from "./control.js";
import type { WorkerControlRequest } from "./control.js";
import { createWorkerDiagnostics, workerSqliteMigrationEvent, type WorkerDiagnosticSinkEvent } from "./diagnostics.js";
import { createWorkerConfigurationDiagnostics } from "./configuration-diagnostics.js";
import { ConfigurationFileOperationError } from "./configuration-failure.js";
import { waitForConfigurationOperation } from "./configuration-persistence.js";
import { isWorkerCancellation } from "./execution.js";
import { hasOwnedCommandCleanupFailure, hasUnconfirmedOwnedCommandCleanup, OwnedCommandCleanupError } from "./owned-command.js";
import { ensureWorkerIdentity, readWorkerIdentity } from "./identity.js";
import { acquireWorkerInstanceLock, tryAcquireWorkerInstanceLock } from "./instance-lock.js";
import { resolveWorkerPaths } from "./paths.js";
import { buildWorkerPrompt } from "./prompts.js";
import { createWorkerPromptSource } from "./prompt-source.js";
import { createWorkerRemote } from "./remote.js";
import { createWorkerReporter } from "./reporter.js";
import { createWorkerConfigurationExchange, failedConfigurationRequestOutcome, syncWorkerConfigurationOnce, workerConfigurationDiagnosticFailures, workerConfigurationRequestId, type WorkerConfigurationExchangeEvent } from "./configuration-exchange.js";
import { createWorkerConfigurationBootstrap } from "./configuration-bootstrap.js";
import { createWorkerRepositoryAdmission, prepareWorkerWorktreeFormat } from "./repository-admission.js";
import { createWorkerTelemetryCollector } from "./telemetry.js";
import { openWorkerStore } from "./store.js";
import { createWorkerBotHost, type WorkerBotHost } from "./bots/host.js";
import { BotCliProbeCleanupError } from "./bots/cli-probe.js";
import { createWorkerReadOnlyChannel } from "./read-only/channel.js";
import { createWorkerDirectoryBrowser } from "./read-only/directory.js";
import { createWorkerModelDiscovery, createWorkerReadOnlyConfiguration, type WorkerModelInput } from "./read-only/models.js";
import type { WorkerReadOnlyOperations, WorkerReadOnlyOperation } from "./read-only/channel.js";
import type { WorkerDirectoryInput } from "./read-only/directory.js";
import { createWorkerGitManager, type WorkerGitPending } from "./worktrees.js";
import { windowsProcessStartTime } from "../../platform/windows-directory-holders.js";
import { normalizeWorkerNative, workerRuntimeConfigurationReport } from "./native-overrides.js";
import type { WorkerLocalNativeOverrides } from "./local-native.js";
import { createWorkerToolSelectionRuntime } from "./tool-selection-runtime.js";
import { readWebToolActivity } from "./tool-activity.js";
import type { ActiveToolSelection } from "./tool-selection.js";
import { createNativeSelectionVerifier } from "./native-selection.js";
import { createExecutionScopeManager, withinExecutionDeadline, type ExecutionScope, type OwnerStopResult } from "./execution-scope.js";
import { openExecutionResourceJournal, type ExecutionResourceIdentity } from "./execution-resource-journal.js";
import { withOwnedCommandLifecycle, retainedOwnedCommandBoundaries, OwnedCommandAdmissionError, type OwnedCommandLifecycleSink } from "./owned-command-lifecycle.js";
import { LifecycleAdmissionError, openLifecycleStore, readLifecycleIdentity, type LifecycleStore, type LifecycleJson } from "./lifecycle-store.js";
import { createLifecycleManager, type LifecycleManager } from "./lifecycle-manager.js";
import { createWorkerLifecycleClient } from "../../api/worker-lifecycle-client.js";
import { readWorkerClaim } from "../../api/task-properties.js";
import { parseFrozenNative } from "./store.js";
import { withWorkerLifecycle } from "./lifecycle-context.js";
import { reconcileLifecycleRequest } from "./lifecycle-request-recovery.js";
import { reconcilePreparedInitialReservation } from "./lifecycle-input-recovery.js";
import { reportLifecycleHeartbeat, runLifecycleHeartbeat } from "./lifecycle-heartbeat.js";
import { collectLifecycleRecovery, selectLifecycleRecoveryResources, type LifecycleRecoverySources } from "./lifecycle-recovery.js";
import { requireWorkerNetworkToken, workerNetworkUnavailable } from "./management-network.js";
import { readControllerSnapshot, readControllerOperation, readHistoricalStoppedControllerGeneration, readProvenWindowsStoppedControllerGeneration } from "../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, type ProcessProof } from "../controller/process-proof.js";
import { preservesControllerProcessProof } from "./backends/orchestration.js";

const gitPendingReporter = (emit: (event: WorkerEvent) => void) => (pending: WorkerGitPending): void => {
  emit({ kind: "git-cleanup-pending", message: `Git ${pending.command} local cleanup remains pending; waiting for local close.`, projectId: pending.projectId,
    ...(pending.owner === undefined ? {} : { identity: pending.owner }), component: "git", phase: pending.command, attemptId: pending.attemptId, error: pending.error });
};
const gitSettledReporter = (emit: (event: WorkerEvent) => void): NonNullable<Parameters<typeof createWorkerGitManager>[0]["reportSettled"]> => (pending, settlement) => {
  emit({ kind: "git-local-closed", message: `Git ${pending.command} local resources closed.`, projectId: pending.projectId,
    ...(pending.owner === undefined ? {} : { identity: pending.owner }), component: "git", phase: pending.command, attemptId: pending.attemptId,
    ...(settlement.cleanupErrors.length === 0 ? {} : { error: new AggregateError(settlement.cleanupErrors, "Repository Git local cleanup reported errors.", { cause: pending.error }) }) });
};


// A cleanup that recovers a held worktree succeeds without any failure to
// carry the record of what it terminated, and the processes it ended may be
// ones the Worker never started. This is the operator's trace for that case.
const holderTerminatedReporter = (emit: (event: WorkerEvent) => void): NonNullable<Parameters<typeof createWorkerGitManager>[0]["reportHolderTerminated"]> => event => {
  // The holder's working directory is often a descendant of the target rather
  // than the target itself, and naming the target as what it held would be
  // wrong. Both belong here: one is the process that was ended, the other is
  // the directory that could not be removed because of it.
  emit({ kind: "worktree-holder-terminated", component: "git", phase: "worktree-remove",
    message: `Terminated ${event.holder.image} (${event.holder.pid}, started ${windowsProcessStartTime(event.holder.birth)}), whose working directory ${event.holder.directory} kept ${event.target} from being removed, together with the processes Windows attributes to it as children (configuration revision ${event.revision}).` });
};

export const currentWorkerPlatform = (platform: NodeJS.Platform = process.platform): TaskPlatform => {
  switch (platform) {
    case "linux": return "linux";
    case "darwin": return "macos";
    case "win32": return "windows";
    default: throw new Error(`Worker execution is unsupported on platform ${platform}.`);
  }
};

const machineDescription = (platform: TaskPlatform): WorkerMachine => {
  const name = hostname();
  // The host label is reported metadata, independent of worker identity and authentication.
  const bytes = createHash("sha1").update(`daynight:machine:${platform}:${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return { id: `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`, name };
};

const runtimeCancellation = (signal?: AbortSignal) => {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(signal?.reason);
  const interrupt = (): void => controller.abort(new Error("Worker operation interrupted."));
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  for (const name of signals) process.on(name, interrupt);
  return {
    controller,
    dispose: (): void => {
      signal?.removeEventListener("abort", cancel);
      for (const name of signals) process.off(name, interrupt);
    },
  };
};

const throwFailures = (failures: readonly unknown[]): void => {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Worker operation and resource cleanup failed.");
};

const projectUnavailable = (error: unknown): boolean => error instanceof ApiError && error.phase === "response" && error.status === 404 && error.code === "not_found";
const configurationPreparationFailure = (error: unknown): unknown => error instanceof Error && "errno" in error && typeof error.errno === "number" && "syscall" in error && typeof error.syscall === "string"
  ? new ConfigurationFileOperationError("directory", error) : error;

const transientAuthorityFailure = (error: unknown): boolean => {
  if (error instanceof OperationError) return error.kind === "deadline" || error.kind === "request_timeout";
  if (!(error instanceof ApiError)) return false;
  if (error.phase === "request") return true;
  if (error.phase !== "response" || error.status === undefined) return false;
  if (error.status === 408 || error.status === 429 || error.status >= 500) return true;
  // Response-body transport failures precede protocol parsing; byte-limit refusals are deterministic.
  return error.status < 400 && error.code === undefined && !(error.cause instanceof OperationError && !transientAuthorityFailure(error.cause));
};

const verifyWorkerPrincipal = async (read: () => Promise<string>, signal: AbortSignal, observe: (event: WorkerConfigurationExchangeEvent) => void): Promise<string> => {
  const delays = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
  let attempt = 0;
  for (;;) {
    signal.throwIfAborted();
    const syncId = randomUUID();
    observe({ syncId, phase: "authority-read", status: "started", source: null, remoteOutcome: "not_sent", localOutcome: "not_attempted" });
    try { const userId = await read(); observe({ syncId, phase: "authority-read", status: "succeeded", source: null, remoteOutcome: "success", localOutcome: "not_attempted" }); return userId; }
    catch (error) {
      const retryMs = signal.aborted || !transientAuthorityFailure(error) ? undefined : delays[Math.min(attempt++, delays.length - 1)]!;
      const requestId = workerConfigurationRequestId(error);
      observe({ syncId, phase: "authority-read", status: signal.aborted ? "discarded" : "failed", source: null, remoteOutcome: failedConfigurationRequestOutcome(error), localOutcome: "not_attempted", ...(retryMs === undefined ? {} : { backoffStep: Math.min(attempt, delays.length) }), nextAttemptAt: retryMs === undefined ? null : new Date(Date.now() + retryMs).toISOString(), error,
        ...(requestId === undefined ? {} : { requestId }) });
      if (retryMs === undefined) throw error;
      await delay(retryMs, undefined, { signal });
    }
  }
};


const prepareWorkerAgentEnvironment = async (paths: WorkerPaths, emit: (event: WorkerEvent) => void, signal: AbortSignal) => {
  const aliases = await prepareAgentCliAliases({ aliases: await readAgentCliAliases(paths, signal), environment: process.env, stateDirectory: paths.stateDirectory });
  const agentEnvironment: { PATH?: string; DN_CONFIG_DIR?: string } = {};
  if (aliases.bindings.length > 0) {
    if (aliases.environment.PATH !== undefined) agentEnvironment.PATH = aliases.environment.PATH;
    for (const binding of aliases.bindings) emit({ kind: "agent-cli-alias", message: `${binding.name} -> ${binding.target} (${binding.executable}).` });
  }
  if (aliases.environment.DN_CONFIG_DIR !== undefined) agentEnvironment.DN_CONFIG_DIR = aliases.environment.DN_CONFIG_DIR;
  return { agentEnvironment };
};

const effectiveExecutionConfiguration = (native: WorkerCloudNative, recoveryLimit: number, local: WorkerLocalNativeOverrides) => ({
  ...resolveCloudNative(normalizeWorkerNative(native, local).native, recoveryLimit),
  ...(local.agentModel !== undefined || local.agentReasoningEffort !== undefined ? { validateNativeSelection: true as const } : {}),
});

const nativeConfigurationApplication = (options: {
  tools?: () => ReturnType<typeof createWorkerToolSelectionRuntime> | undefined;
  paths: WorkerPaths; homeDirectory: string; workingDirectory: string;
  overrides: WorkerLocalNativeOverrides;
  signal: AbortSignal; emit: (event: WorkerEvent) => void;
}) => {
  let environment: Awaited<ReturnType<typeof prepareWorkerAgentEnvironment>> | undefined;
  let pending: Promise<Awaited<ReturnType<typeof prepareWorkerAgentEnvironment>>> | undefined;
  const getEnvironment = async (): Promise<Awaited<ReturnType<typeof prepareWorkerAgentEnvironment>>> => {
    if (environment !== undefined) return environment;
    if (pending === undefined) pending = prepareWorkerAgentEnvironment(options.paths, options.emit, options.signal);
    const attempt = pending;
    try { environment = await attempt; return environment; }
    finally { if (pending === attempt) pending = undefined; }
  };
  return {
    current: () => environment,
    apply: async (native: WorkerCloudNative, signal: AbortSignal): Promise<void> => {
      normalizeWorkerNative(native, options.overrides);
      const nativeEnvironment = await getEnvironment();
      const tools = options.tools?.();
      if (tools !== undefined) {
        await tools.prepareNative(native, signal);
        if (native.agent === "codex" || native.agent === "copilot") return;
      }
      const operation = createOperation({ signal, limits: { totalMs: 15_000, requestMs: 10_000 } });
      try { await probeNativeAgentVersion({ agent: native.agent, environment: { ...process.env, ...nativeEnvironment.agentEnvironment }, cwd: options.workingDirectory }, operation); }
      finally { operation.dispose(); }
    },
  };
};

const createWebRuntime = async (options: { homeDirectory: string; packageDirectory: string; managementOnly?: boolean }, paths: WorkerPaths, store: ReturnType<typeof openWorkerStore>, git: ReturnType<typeof createWorkerGitManager>, serverUrl: string, serverToken: string | undefined, workerId: string, userId: string, platform: TaskPlatform, emit: (event: WorkerEvent) => void, signal: AbortSignal, promptSource?: ReturnType<typeof createWorkerPromptSource>, preparePromptSource?: (projectId: string, signal: AbortSignal) => Promise<void>, monitoring?: ReturnType<typeof createMonitoringObserver>, tools?: ReturnType<typeof createWorkerToolSelectionRuntime>, archiveSessions?: () => boolean | null) => {
  const webStore = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite"), { onMigration: event => { emit(workerSqliteMigrationEvent(event)); } });
  try {
    const api = createWorkerSessionApi(serverUrl, serverToken, { managementOnly: options.managementOnly ?? false });
    const jobLeases = createControllerJobLeases();
    const launcher = createWebControllerLauncher({ ...options, jobLeases, ...(tools === undefined ? {} : { selectToolLaunch: tools.selectToolLaunch, toolObservationFor: tools.toolObservationFor }), store: webStore, sessionApi: api, now: Date.now });
    const archive: NonNullable<import("./backends/web.js").WebBackendOptions["archive"]> = async (task, journalPath, signal) => {
      if (!task.webExecution) throw new Error("Original controller execution is missing.");
      const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution.launchId);
      if (ticket.serverOrigin !== serverUrl || task.serverOrigin !== serverUrl || ticket.executionId !== task.webExecution.executionId
        || ticket.executionGeneration !== task.webExecution.executionGeneration || ticket.controllerInstanceId !== task.webExecution.controllerInstanceId
        || ticket.claimId !== task.claimId || ticket.sessionId !== task.webExecution.sessionId) throw new Error("Archive does not identify the original execution.");
      await uploadStoppedControllerArchive({ journalPath, ticket, serverToken: requireWorkerNetworkToken(serverToken), signal,
        onRetry: event => emit({ kind: "session-archive-retry", component: "archive", phase: "archive-backfill", message: `Session archive capacity ${JSON.stringify(event)}` }),
      });
    };
    const probeArchive: NonNullable<import("./backends/web.js").WebBackendOptions["probeArchive"]> = async (task, journalPath, signal) => {
      signal.throwIfAborted();
      if (!task.webExecution) throw new Error("Original controller execution is missing.");
      const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution.launchId);
      if (ticket.serverOrigin !== serverUrl || task.serverOrigin !== serverUrl || ticket.executionId !== task.webExecution.executionId
        || ticket.executionGeneration !== task.webExecution.executionGeneration || ticket.controllerInstanceId !== task.webExecution.controllerInstanceId
        || ticket.claimId !== task.claimId || ticket.sessionId !== task.webExecution.sessionId) throw new Error("Archive probe does not identify the original execution.");
      return probeStoppedControllerArchive({ journalPath, ticket, signal });
    };
    const usage = async (task: import("./backends/web-types.js").LocalTask, journalPath: string, signal: AbortSignal) => {
      if (!task.webExecution) throw new Error("Original Controller execution is missing.");
      const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution.launchId);
      if (ticket.serverOrigin !== serverUrl || task.serverOrigin !== serverUrl || ticket.executionId !== task.webExecution.executionId
        || ticket.executionGeneration !== task.webExecution.executionGeneration || ticket.controllerInstanceId !== task.webExecution.controllerInstanceId
        || ticket.claimId !== task.claimId || ticket.sessionId !== task.webExecution.sessionId || ticket.workerId !== workerId || ticket.userId !== userId) throw new Error("Usage replay does not identify the original execution.");
      return replayStoppedControllerUsage({ journalPath, ticket, serverToken: requireWorkerNetworkToken(serverToken), signal });
    };
    const archiveMaintenance = createWebArchiveMaintenance({ homeDirectory: options.homeDirectory, serverUrl, workerId, userId, signal, store, webStore, archive, probeArchive, usage, emit, ...(archiveSessions === undefined ? {} : { archiveSessions }), ...(monitoring === undefined ? {} : { monitoring }) });
    const webBackend = createWebExecutionBackend({ homeDirectory: options.homeDirectory, store: webStore, git, launcher, jobLeases, platform, now: Date.now, archive, probeArchive, onArchiveFailure: archiveMaintenance.recordFailure, ...(archiveSessions === undefined ? {} : { archiveSessions }), ...(monitoring === undefined ? {} : { onUnattributed: (identity: { projectId: string; taskId: string; claimId: string }, operationKey: string, value: boolean) => monitoring.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operationKey}`, value) }), ...(promptSource === undefined ? {} : { promptSource }), ...(preparePromptSource === undefined ? {} : { preparePromptSource }),
      buildPrompt: (task, actualPlatform) => {
        if (task.configuration === null || task.resources.worktree === null) throw new Error("The frozen Web assignment is incomplete.");
        return buildWorkerPrompt({ ...task, agent: task.configuration.agent, agentControlMode: "web", sessionId: task.resources.nativeSession?.sessionId ?? null, configuration: task.configuration, worktree: task.resources.worktree }, actualPlatform);
      },
      emit: event => {
        const task = event.task === undefined ? null : store.getTask(event.task);
        emit({ kind: event.kind, message: event.message, ...(event.task === undefined ? {} : { identity: { projectId: event.task.projectId, taskId: event.task.taskId, claimId: event.task.claimId, worktreeId: event.task.worktreeId } }), ...(task === null ? {} : { task }), ...(event.component === undefined ? {} : { component: event.component }), ...(event.phase === undefined ? {} : { phase: event.phase }), ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }), ...(event.runKey === undefined ? {} : { runKey: event.runKey }), ...(event.error === undefined ? {} : { error: event.error }) });
      },
    });
    return { webStore, webBackend, launcher, jobLeases, archiveMaintenance, verifyWebServer: api.verifySupport, verifyWebUnregistered: api.verifyUnregistered, verifyWebStartupReporting: api.supportsStartupReports };
  } catch (error) {
    try { webStore.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Web runtime initialization and store shutdown failed."); }
    throw error;
  }
};

const webToolSelections = (homeDirectory: string, web: Awaited<ReturnType<typeof createWebRuntime>> | undefined): ActiveToolSelection[] => web?.webStore.listUnfinishedTasks().flatMap(task => {
  const execution = task.webExecution, tool = task.configuration?.agent;
  if (execution === null || tool !== "codex" && tool !== "copilot") return [];
  const activity = readWebToolActivity(homeDirectory, task); if (activity === "inactive") return [];
  const unknown = activity === "unconfirmed";
  return [{ tool, context: "web", launch: task.configuration!.toolLaunch ?? null, version: task.configuration!.toolObservation?.version ?? null, checkedAt: task.configuration!.toolObservation?.checkedAt ?? null, executionCount: unknown ? null : 1, instanceCount: 0, unconfirmedCount: unknown ? 1 : 0 }];
}) ?? [];

export type WorkerExecutionControl = {
  readonly generation: string;
  snapshot: ExecutionScope["snapshot"];
  stop(options?: { deadline: number }): Promise<OwnerStopResult[]>;
  reconcile(options?: { deadline: number }): Promise<OwnerStopResult[]>;
  rebuild(): void;
};
type WorkerRunOptions = {
  homeDirectory: string; packageDirectory: string; version: string; workingDirectory: string;
  log?: (message: string) => void; signal?: AbortSignal;
  onExecutionScope?: (control: WorkerExecutionControl) => void;
  lifecycle?: boolean;
};
type WorkerManagementRoot = {
  cancellation: ReturnType<typeof runtimeCancellation>;
  previousScopeFailures: unknown[];
  managementClosed: boolean;
  managementClosing?: Promise<void>;
  lifecycleReconciliation?: { work: Promise<void>; closed: boolean; retry(deadline: number): Promise<void> };
  workerDirectory?: string;
  retirementReady?: boolean;
  releasing?: Promise<void>;
  lock?: Awaited<ReturnType<typeof acquireWorkerInstanceLock>>;
  store?: ReturnType<typeof openWorkerStore>;
  identity?: ExecutionResourceIdentity;
  journal?: Awaited<ReturnType<typeof openExecutionResourceJournal>>;
  lifecycle?: LifecycleStore;
  manager?: LifecycleManager;
  ipc?: { close(): Promise<void> };
  heartbeat?: Promise<void>;
  executionReporterActive?: boolean;
  recoverySources?: LifecycleRecoverySources;
  readRecoverySources?: () => LifecycleRecoverySources;
};
const synchronizeCommandStopReceipts = async (root: WorkerManagementRoot): Promise<void> => {
  if (root.lifecycle === undefined || root.journal === undefined) return;
  for (const record of await root.journal.read()) {
    if (record.event.stage !== "stopped") continue;
    const resource = root.lifecycle.readResource(record.event.resourceId);
    if (resource === null || ["stopped", "confirmed", "not_dispatched"].includes(resource.stage)) continue;
    if (resource.scopeGeneration !== record.generation || resource.processProof !== null && !isDeepStrictEqual(resource.processProof, record.event.proof)) throw new Error("Command stop receipt conflicts with its original lifecycle reservation.");
    root.lifecycle.recordResource({ resourceId: resource.resourceId, stage: "stopped", stopProof: { kind: "owned_boundary", sequence: record.event.sequence }, saveState: "durable" });
  }
};
const retainedManagementRoots = new Set<WorkerManagementRoot>();
const releaseRetiredManagementRoot = async (root: WorkerManagementRoot): Promise<void> => {
  if (!root.retirementReady || !root.managementClosed || root.lifecycleReconciliation?.closed === false) return;
  if (root.releasing !== undefined) return root.releasing;
  root.releasing = Promise.resolve().then(async () => {
    try { root.lifecycle?.close(); root.store?.close(); await root.lock?.release(); retainedManagementRoots.delete(root); }
    catch (error) { retainedManagementRoots.add(root); delete root.releasing; throw error; }
  });
  return root.releasing;
};
const retireManagementRoot = async (root: WorkerManagementRoot): Promise<void> => {
  root.retirementReady = true;
  retainedManagementRoots.add(root);
  await releaseRetiredManagementRoot(root);
  if (!retainedManagementRoots.has(root)) return;
  // A timed-out observer does not own the lifetime of its original writers.
  void Promise.allSettled([root.managementClosing, root.lifecycleReconciliation?.work]).then(() => releaseRetiredManagementRoot(root))
    .catch(error => process.emitWarning(`Worker management cleanup remains unconfirmed: ${String(error)}`));
};
const reconcileRetiredManagementRoot = async (paths: WorkerPaths, workerId?: string): Promise<void> => {
  for (const root of retainedManagementRoots) {
    if (root.workerDirectory !== paths.workerDirectory || !root.retirementReady || root.lifecycleReconciliation === undefined) continue;
    const local = await readWorkerLocalConfiguration(paths), original = await readWorkerIdentity(paths);
    if (root.identity?.workerId !== original || workerId !== undefined && workerId !== original || local.serverUrl !== root.identity.serverOrigin)
      throw new Error("Retained management cleanup does not identify the original Worker.");
    try { await root.lifecycleReconciliation.retry(Date.now() + 10_000); }
    finally { await releaseRetiredManagementRoot(root); }
    if (retainedManagementRoots.has(root)) throw new Error("Original Worker management resources remain owned.");
  }
};
const managementRemote = (serverUrl: string, serverToken: string | undefined) => new Proxy(createWorkerRemote({ serverUrl, ...(serverToken === undefined ? {} : { serverToken }) }), {
  get(target, key, receiver): unknown {
    const value: unknown = Reflect.get(target, key, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => { requireWorkerNetworkToken(serverToken); return Reflect.apply(value, target, args); };
  },
});
const managementLifecycleClient = (serverUrl: string, serverToken: string | undefined, identity: ExecutionResourceIdentity): ReturnType<typeof createWorkerLifecycleClient> =>
  serverToken === undefined ? { read: workerNetworkUnavailable, register: workerNetworkUnavailable, intent: workerNetworkUnavailable, activate: workerNetworkUnavailable,
    operation: workerNetworkUnavailable, resolve: workerNetworkUnavailable, report: workerNetworkUnavailable }
    : createWorkerLifecycleClient({ serverUrl, serverToken, workerId: identity.workerId, userId: identity.userId });
const retainedResourceId = (identity: readonly (string | null)[]): string => {
  const bytes = createHash("sha256").update(JSON.stringify(identity)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Reuses the normal stop owners without starting their discovery or application loops. */
const reconcileLifecycleResources = async (options: WorkerRunOptions, root: WorkerManagementRoot, deadline: number): Promise<void> => {
  const previous = root.lifecycleReconciliation;
  if (previous !== undefined && !previous.closed) { await previous.retry(deadline); return; }
  const paths = resolveWorkerPaths(options.homeDirectory), identity = root.identity!, lifecycle = root.lifecycle!;
  const local = await readWorkerLocalConfiguration(paths, root.cancellation.controller.signal);
  if (local.serverUrl !== identity.serverOrigin) throw new Error("Original Worker service identity is unavailable for management.");
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const emit = (event: WorkerEvent): void => options.log?.(`${event.message}\n`);
  const repository = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory, reportPending: gitPendingReporter(emit), reportSettled: gitSettledReporter(emit),
    prepareFormat: (project, repository, operation) => prepareWorkerWorktreeFormat({ paths, store: root.store!, project, repository, operation,
      workerId: identity.workerId, serverOrigin: identity.serverOrigin }),
  });
  const git: ReturnType<typeof createWorkerGitManager> = { ...repository,
    resolveWorktreeBinding: async (project, owner, operation) => {
      const retained = root.store!.getProject(project);
      if (retained === null || retained.repoUrl !== project.repoUrl || retained.localPath !== project.localPath)
        throw new Error("Original Task repository binding is unavailable for management cleanup.");
      const directory = await lstat(retained.localPath);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Original Task repository must be an ordinary directory.");
      await repository.prepareRepository(retained, operation);
      return repository.resolveWorktreeBinding(retained, owner, operation);
    },
  };
  let web: Awaited<ReturnType<typeof createWebRuntime>> | undefined;
  let bots: WorkerBotHost | undefined;
  let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
  let activeDeadline = deadline;
  const currentTasks = new Map<string, Promise<Task>>();
  const unresolvedTasks = new Set<string>();
  const pendingClaims: ClaimIdentity[] = [];
  const imported: { resourceId: string; group: "task" | "bot" }[] = [];
  let claimErrors: unknown[] = [];
  let reconcileClaimRequests: () => Promise<void>;
  const importTask = (task: ClaimIdentity): void => {
    const state = lifecycle.readState();
    if (state.instanceId === null || state.instanceEpoch === null || state.intentVersion === null) return;
    const resourceId = retainedResourceId(["task", task.claimId, state.scopeGeneration]);
    const resource = lifecycle.importResource({ binding: { ...identity, instanceId: state.instanceId, instanceEpoch: state.instanceEpoch, intentVersion: state.intentVersion, localEpoch: state.localEpoch, scopeGeneration: state.scopeGeneration },
      resourceId, operationId: task.claimId, ownerKind: "task", identity: { kind: "retained_task", projectId: task.projectId, taskId: task.taskId, claimId: task.claimId } });
    if (!["stopped", "confirmed", "not_dispatched"].includes(resource.stage)) imported.push({ resourceId: resource.resourceId, group: "task" });
  };
  type CloseStep = { start(): Promise<void>; work?: Promise<void>; failed?: boolean };
  const step = (start: () => Promise<void>): CloseStep => ({ start });
  const join = (entry: CloseStep, reobserve = false): Promise<void> => {
    if (entry.work === undefined || reobserve && entry.failed) {
      entry.failed = false;
      entry.work = Promise.resolve().then(entry.start).catch(error => { entry.failed = true; throw error; });
    }
    return entry.work;
  };
  const stopTasks = step(async () => {
    if (coordinator === undefined) return;
    const claims = reconcileClaimRequests();
    const complete = await coordinator.shutdown({ deadline: activeDeadline, currentTasks, pendingClaims, unresolvedTasks });
    await claims;
    throwFailures([...claimErrors, ...(complete ? [] : [new Error("Original Task stop inventory remains incomplete.")])]);
    for (const item of imported.filter(item => item.group === "task")) {
      const resource = lifecycle.readResource(item.resourceId);
      if (resource !== null && !["stopped", "confirmed", "not_dispatched"].includes(resource.stage)) lifecycle.recordResource({ resourceId: item.resourceId, stage: "stopped", stopProof: { kind: "task_shutdown", resourceId: item.resourceId }, saveState: "durable", error: null });
    }
  });
  const stopBots = step(async () => { await bots?.shutdown({ deadline: activeDeadline }); });
  const closeBots = step(async () => { await bots?.close(); });
  const stopJournal = step(async () => {
    for (const generation of new Set((await root.journal!.read()).map(record => record.generation)))
      await root.journal!.reconcileRetained({ generation, deadline: activeDeadline });
    await synchronizeCommandStopReceipts(root);
  });
  const stopControllers = step(async () => {
    for (const resource of lifecycle.listResources()) {
      if (["stopped", "confirmed", "not_dispatched"].includes(resource.stage)) continue;
      if (resource.ownerKind !== "controller" || resource.processProof === null || typeof resource.identity.journalFile !== "string") continue;
      if (unresolvedTasks.has(`${resource.identity.projectId}/${resource.identity.taskId}`)) continue;
      const current = readControllerSnapshot(resource.identity.journalFile);
      if (current === null || current.executionId !== resource.identity.executionId) throw new Error("Original lifecycle Controller journal identity is unavailable.");
      const historical = current.controllerInstanceId !== resource.identity.controllerInstanceId
        || typeof resource.identity.executionGeneration === "string" && current.executionGeneration !== resource.identity.executionGeneration;
      let saved = current;
      if (historical) {
        const { readLifecycleControllerTicket } = await import("./lifecycle-controller-ticket.js");
        const ticket = await readLifecycleControllerTicket(options.homeDirectory, identity, resource);
        const stopped = readHistoricalStoppedControllerGeneration(resource.identity.journalFile, ticket, activeDeadline);
        if (stopped === null || stopped.controllerProcess === null || !preservesControllerProcessProof(resource.processProof as ProcessProof, stopped.controllerProcess, ticket.launchId)) throw new Error("Original lifecycle Controller journal identity is unavailable.");
        saved = stopped;
      }
      if (saved.controllerProcess === null) throw new Error("Original lifecycle Controller journal identity is unavailable.");
      if (process.platform === "win32") {
        if (!historical) {
          const { readLifecycleControllerTicket } = await import("./lifecycle-controller-ticket.js");
          const ticket = await readLifecycleControllerTicket(options.homeDirectory, identity, resource);
          readProvenWindowsStoppedControllerGeneration(resource.identity.journalFile, ticket, activeDeadline);
        }
      } else if (!await confirmControllerProcessesStopped(resource.processProof as ProcessProof, saved.nativeProcesses, activeDeadline)) throw new Error("Original lifecycle native boundary is not empty.");
      lifecycle.recordResource({ resourceId: resource.resourceId, stage: "stopped", stopProof: { kind: "controller_boundary", executionId: saved.executionId, controllerInstanceId: saved.controllerInstanceId, nativeSessionId: saved.nativeSessionId }, saveState: "durable" });
    }
  });
  const settlePreparedInputs = step(async () => {
    for (const resource of lifecycle.listResources()) {
      if (resource.ownerKind !== "controller" || resource.identity.kind !== "input" || resource.identity.operationKind !== "initial"
        || resource.stage !== "reserved" || typeof resource.identity.journalFile !== "string") continue;
      const saved = readControllerSnapshot(resource.identity.journalFile);
      if (saved === null || BigInt(saved.executionGeneration) <= 1n || saved.initialInputState !== "not_submitted") continue;
      await reconcilePreparedInitialReservation({ homeDirectory: options.homeDirectory, identity, lifecycle, resource, deadline: activeDeadline });
    }
  });
  const closeArchive = step(async () => { await web?.archiveMaintenance.close(); });
  const closeLeases = step(async () => { await web?.jobLeases.close(); });
  const closeInput = step(async () => { web?.webBackend.closeInput(); });
  const closeStore = step(async () => { web?.webStore.close(); });
  const closeGit = step(async () => { await git.dispose(); });
  const cleanup = async (reobserve: boolean): Promise<void> => {
    const results = await Promise.allSettled([
      (async () => { await join(stopBots, reobserve); await join(closeBots, reobserve); })(),
      join(stopJournal, reobserve),
      (async () => {
        const taskStop = await Promise.allSettled([join(stopTasks, reobserve)]);
        const receipts = await Promise.allSettled([synchronizeCommandStopReceipts(root)]);
        const controllerStop = await Promise.allSettled([join(stopControllers, reobserve)]);
        throwFailures([...taskStop, ...receipts, ...controllerStop].flatMap(result => result.status === "rejected" ? [result.reason] : []));
        await join(settlePreparedInputs, reobserve);
        await join(closeArchive, reobserve); await join(closeLeases, reobserve);
        await join(closeInput, reobserve); await join(closeStore, reobserve); await join(closeGit, reobserve);
      })(),
    ]);
    throwFailures(results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
    retained.closed = true;
  };
  const initial = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      const remote = managementRemote(local.serverUrl, local.serverToken);
      reconcileClaimRequests = async (): Promise<void> => {
      currentTasks.clear(); unresolvedTasks.clear(); pendingClaims.length = 0; claimErrors = [];
      const claimSignal = AbortSignal.timeout(Math.max(1, activeDeadline - Date.now()));
      for (const resource of lifecycle.listResources().filter(resource => resource.identity.kind === "task_claim" && !["confirmed", "stopped", "not_dispatched"].includes(resource.stage))) {
        const original = resource.identity;
        const taskKey = `${original.projectId}/${original.taskId}`;
        if (typeof original.projectId === "string" && typeof original.taskId === "string" && typeof original.claimId === "string") pendingClaims.push({ projectId: original.projectId, taskId: original.taskId, claimId: original.claimId });
        const previous = currentTasks.get(taskKey);
        const observed = (async (): Promise<Task> => {
        if (previous !== undefined) await previous;
        if (typeof original.projectId !== "string" || typeof original.taskId !== "string" || typeof original.claimId !== "string" || typeof original.worktreeId !== "string" || typeof original.candidateVersion !== "string") throw new Error("Original claim reservation identity is incomplete.");
        if (await remote.currentUserId(claimSignal) !== identity.userId) throw new Error("Original claim reconciliation account changed.");
        const task = await remote.readTask(original.projectId, original.taskId, claimSignal), claim = readWorkerClaim(task.properties);
        const taskIdentity = { projectId: original.projectId, taskId: original.taskId, claimId: original.claimId };
        if (task.status === "in_progress" && claim?.claimId === original.claimId && claim.workerId === identity.workerId && claim.worktreeId === original.worktreeId && claim.state === "active") {
          if (root.store!.getTask(taskIdentity) === null) {
            const reserved = root.store!.getClaimToolReservation(taskIdentity);
            if (reserved !== null) root.store!.acceptClaimToolReservation(task, identity.workerId);
            else root.store!.registerPending({ ...taskIdentity, agent: claim.agent, agentControlMode: "web", nativeConfiguration: parseFrozenNative(original.frozenConfiguration) });
          }
          importTask(taskIdentity);
          lifecycle.recordResource({ resourceId: resource.resourceId, stage: "confirmed", saveState: "durable", error: null });
        } else if (task.version > BigInt(original.candidateVersion)) {
          const reserved = root.store!.getClaimToolReservation(taskIdentity);
          if (reserved !== null) root.store!.releaseClaimToolReservation(reserved);
          lifecycle.recordResource({ resourceId: resource.resourceId, stage: "stopped", stopProof: { kind: "claim_superseded", taskVersion: String(task.version), originalClaimId: original.claimId }, saveState: "durable" });
        } else throw new Error("Original claim request outcome remains unconfirmed.");
        return task;
        })().catch(error => { unresolvedTasks.add(taskKey); throw error; });
        currentTasks.set(taskKey, observed);
      }
      const results = await Promise.allSettled(currentTasks.values());
      claimErrors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      };
      web = await createWebRuntime({ ...options, managementOnly: true }, paths, root.store!, git, local.serverUrl, local.serverToken, identity.workerId, identity.userId, currentWorkerPlatform(), emit, signal);
      coordinator = createWorkerCoordinator({ store: root.store!, git, remote, webStore: web.webStore, webBackend: web.webBackend,
        retiredNativeCleanup: createRetiredClaimNativeCleanup({ homeDirectory: options.homeDirectory, identity, lifecycle, jobLeases: web.jobLeases }),
        verifyWebUnregistered: web.verifyWebUnregistered, serverOrigin: identity.serverOrigin, workerId: identity.workerId, userId: identity.userId,
        platform: currentWorkerPlatform(), machine: machineDescription(currentWorkerPlatform()), repositories: [], globalConfiguration: null, maxConcurrent: 1,
        preferPlatformSpecificTasks: false, emit });
      bots = createWorkerBotHost({ homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, workingDirectory: options.workingDirectory,
        paths, owner: { serverOrigin: identity.serverOrigin, ownerUserId: identity.userId, workerId: identity.workerId }, serverToken: local.serverToken, managementOnly: true,
        configuration: () => null, canAdmitNewExecution: () => false, pollIntervalMs: () => null, recoveryLimit: () => null, emit });
      const state = lifecycle.readState();
      if (state.instanceId !== null && state.instanceEpoch !== null && state.intentVersion !== null) {
        const binding = { ...identity, instanceId: state.instanceId, instanceEpoch: state.instanceEpoch, intentVersion: state.intentVersion, localEpoch: state.localEpoch, scopeGeneration: state.scopeGeneration };
        for (const task of root.store!.listUnfinishedTasks()) {
          importTask(task);
        }
        for (const bot of bots.snapshot().resources) {
          const resourceId = retainedResourceId(["bot", bot.botId, bot.executionId, bot.executionGeneration, state.scopeGeneration]);
          const resource = lifecycle.importResource({ binding, resourceId, operationId: resourceId, ownerKind: "bot", identity: { kind: "retained_bot", ...bot } });
          if (!["stopped", "confirmed", "not_dispatched"].includes(resource.stage)) imported.push({ resourceId, group: "bot" });
        }
      }
      const stopped = await Promise.allSettled([
        join(stopTasks),
        join(stopBots),
        join(stopJournal),
      ]);
      root.recoverySources = { tasks: coordinator.executionSnapshot().recovery, bots: bots.snapshot().recovery };
      failures.push(...stopped.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      for (const item of imported.filter(item => item.group === "bot")) if (stopped[1]?.status === "fulfilled") lifecycle.recordResource({ resourceId: item.resourceId, stage: "stopped", stopProof: { kind: "bot_shutdown", resourceId: item.resourceId }, saveState: "durable", error: null });
      for (const resource of lifecycle.listResources()) {
        if (["stopped", "confirmed", "not_dispatched"].includes(resource.stage)) continue;
        if (resource.ownerKind === "assistant" && resource.processProof === null) {
          if (local.serverToken === undefined) continue;
          const result = await reconcileLifecycleRequest({ resource, identity, serverToken: local.serverToken, signal });
          if (result.kind === "settled") lifecycle.recordResource({ resourceId: resource.resourceId, stage: result.stage,
            stopProof: { kind: "external_result", operationId: resource.operationId, receipt: result.receipt }, saveState: "durable", error: null });
          continue;
        }
        if ((resource.identity.kind === "task_advance" && stopped[0]?.status === "fulfilled") || (resource.identity.kind === "bot_advance" && stopped[1]?.status === "fulfilled")) {
          lifecycle.recordResource({ resourceId: resource.resourceId, stage: "stopped", stopProof: { kind: "producer_recovered", resourceId: resource.resourceId }, saveState: "durable" });
          continue;
        }
        if (resource.identity.kind === "input" && typeof resource.identity.journalFile === "string") {
          const operation = readControllerOperation(resource.identity.journalFile, resource.operationId);
          if (operation !== null && operation.executionGeneration === resource.identity.executionGeneration) {
            if (["confirmed", "failed", "provider_accepted"].includes(operation.state)) lifecycle.recordResource({ resourceId: resource.resourceId, stage: "confirmed", saveState: "durable" });
            else if (["rejected", "expired"].includes(operation.state)) lifecycle.recordResource({ resourceId: resource.resourceId, stage: "not_dispatched", saveState: "durable" });
          }
          continue;
        }
      }
    } catch (error) { failures.push(error); }
    finally { try { await cleanup(false); } catch (error) { failures.push(error); } }
    throwFailures(failures);
  };
  let settled = false;
  const observe = (work: Promise<void>): Promise<void> => {
    const original = work.finally(() => { settled = true; });
    void original.then(() => releaseRetiredManagementRoot(root), () => releaseRetiredManagementRoot(root))
      .catch(error => process.emitWarning(`Worker management cleanup remains unconfirmed: ${String(error)}`));
    return original;
  };
  const retained: NonNullable<WorkerManagementRoot["lifecycleReconciliation"]> = {
    closed: false, work: Promise.resolve(),
    retry: async nextDeadline => {
      if (settled && !retained.closed) {
        settled = false; activeDeadline = nextDeadline; retained.work = observe(cleanup(true));
      }
      await withinExecutionDeadline(retained.work, Math.min(nextDeadline, Date.now() + 10_000));
    },
  };
  root.lifecycleReconciliation = retained;
  retained.work = observe(Promise.resolve().then(initial));
  await retained.retry(deadline);
};

const prepareLifecycleManagement = async (options: WorkerRunOptions, root: WorkerManagementRoot, managementWorkerId?: string): Promise<void> => {
  const paths = resolveWorkerPaths(options.homeDirectory), signal = root.cancellation.controller.signal;
  root.workerDirectory = paths.workerDirectory;
  await reconcileRetiredManagementRoot(paths, managementWorkerId);
  const local = await readWorkerLocalConfiguration(paths, signal);
  root.lock ??= await acquireWorkerInstanceLock(paths);
  if (process.platform !== "win32") await chmod(paths.workerDirectory, 0o700);
  const workerId = managementWorkerId === undefined && local.serverToken !== undefined ? await ensureWorkerIdentity(paths, signal) : await readWorkerIdentity(paths, signal);
  if (managementWorkerId !== undefined && workerId !== managementWorkerId) throw new Error("Local management does not identify the original Worker.");
  const remote = managementRemote(local.serverUrl, local.serverToken);
  const file = path.join(paths.workerDirectory, "lifecycle.sqlite");
  const userId = existsSync(file) ? readLifecycleIdentity({ file, serverOrigin: local.serverUrl, workerId }).userId : await remote.currentUserId(signal);
  root.identity = { serverOrigin: local.serverUrl, userId, workerId };
  root.store = openWorkerStore(paths.databaseFile);
  root.lifecycle = openLifecycleStore({ file, identity: root.identity, allowCreate: !root.store.lifecycleAdopted() });
  root.store.adoptLifecycle(root.identity);
  signal.addEventListener("abort", () => { try { root.lifecycle?.closeForRestart(); } catch (error) { options.log?.(`Worker lifecycle persistence failed: ${String(error)}\n`); } }, { once: true });
  root.journal = await openExecutionResourceJournal({ directory: path.join(paths.workerDirectory, "execution-resources"), identity: root.identity });
  let heartbeatReport: Promise<Awaited<ReturnType<typeof remote.report>>> | undefined;
  let workerRegistered = false;
  const heartbeat = { signal, machine: machineDescription(currentWorkerPlatform()), platform: currentWorkerPlatform(),
    workingDirectory: options.workingDirectory, version: options.version, executionReporterActive: () => root.executionReporterActive === true,
    send: async (report: Parameters<typeof remote.report>[1], operation: Operation) => {
      const pending = heartbeatReport ??= (async () => {
        if (await remote.currentUserId(operation.signal) !== userId) throw new Error("Original Worker management account changed.");
        return remote.report(workerId, report, operation);
      })();
      try { const receipt = await pending; workerRegistered = true; return receipt; } finally { if (heartbeatReport === pending) heartbeatReport = undefined; }
    }, reportError: (error: unknown) => options.log?.(`Worker management heartbeat: ${String(error)}\n`) };
  root.manager = createLifecycleManager({ store: root.lifecycle, api: managementLifecycleClient(local.serverUrl, local.serverToken, root.identity),
    ensureWorkerRegistered: async refresh => { if (refresh || !workerRegistered) await reportLifecycleHeartbeat(heartbeat); },
    recovery: () => {
      const sources = root.readRecoverySources?.() ?? root.recoverySources ?? {};
      const claims = new Set(root.store!.listUnfinishedTasks().map(task => task.claimId));
      const botIds = new Set(sources.bots?.map(bot => bot.botId) ?? []);
      const resources = selectLifecycleRecoveryResources(root.lifecycle!.listResources(), { unfinishedClaimIds: claims, ...(sources.bots === undefined ? {} : { currentBotIds: botIds }) });
      return collectLifecycleRecovery({ resources, ...sources });
    },
    platform: currentWorkerPlatform(), signal, reconcileResources: deadline => reconcileLifecycleResources(options, root, deadline), reportError: error => options.log?.(`Worker lifecycle: ${error instanceof Error ? error.message : String(error)}\n`) });
  if (managementWorkerId === undefined) {
    const { startLifecycleIpcServer } = await import("./lifecycle-ipc.js");
    root.ipc = await startLifecycleIpcServer({ workerDirectory: paths.workerDirectory, identity: root.identity,
      handle: async request => {
        if (request.kind === "resume") { if (request.operationId === null) throw new Error("Resume requires its original operation ID."); await root.manager!.resume(request.operationId); }
        else if (request.kind !== "query") await root.manager!.reconcile();
      },
    });
    root.manager.start();
    root.heartbeat = runLifecycleHeartbeat(heartbeat);
  }
};

export const runManagedWorker = (options: Omit<WorkerRunOptions, "lifecycle">): Promise<void> => runWorker({ ...options, lifecycle: true });

export const runLifecycleManagementOnly = async (options: { homeDirectory: string; packageDirectory: string; version: string; workerId: string; operationId: string; kind: "disable" | "reconcile" | "resume"; signal?: AbortSignal }): Promise<void> => {
  const paths = resolveWorkerPaths(options.homeDirectory), cancellation = runtimeCancellation(options.signal);
  try { await reconcileRetiredManagementRoot(paths, options.workerId); }
  catch (error) { cancellation.dispose(); throw error; }
  const lock = await tryAcquireWorkerInstanceLock(paths);
  if (lock === null) { cancellation.dispose(); return; }
  const root: WorkerManagementRoot = { cancellation, lock, managementClosed: true, previousScopeFailures: [] };
  try {
    const execution = { ...options, workingDirectory: process.cwd() };
    await prepareLifecycleManagement(execution, root, options.workerId);
    if (root.identity?.workerId !== options.workerId) throw new Error("Local management does not identify the original Worker.");
    if (options.kind === "resume") { root.manager!.start(); await root.manager!.resume(options.operationId); }
    else await root.manager!.reconcile();
  } finally {
    cancellation.controller.abort();
    try { await root.manager?.close(); await retireManagementRoot(root); }
    finally { cancellation.dispose(); }
  }
};

const isCommandCleanupFailure = (error: unknown): boolean =>
  error instanceof OwnedCommandCleanupError || error instanceof BotCliProbeCleanupError ||
  (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isCommandCleanupFailure)
    && (error.cause === undefined || isCommandCleanupFailure(error.cause)));

export const runWorker = async (options: WorkerRunOptions): Promise<void> => {
  if (options.signal?.aborted) return;
  const cancellation = runtimeCancellation(options.signal);
  const root: WorkerManagementRoot = { cancellation, previousScopeFailures: [], managementClosed: true };
  const scopes = createExecutionScopeManager(cancellation.controller.signal);
  try {
    if (options.lifecycle) await prepareLifecycleManagement(options, root);
    do {
      const lifecycleBinding = await root.manager?.waitForAdmission();
      await withinExecutionDeadline(root.journal?.assertClosed() ?? Promise.resolve(), Date.now() + 10_000);
      const scope = scopes.create(lifecycleBinding?.scopeGeneration);
      const admittedResources = new Map<string, string>();
      const failures: unknown[] = [];
      const failCommandPersistence = (error: unknown): never => {
        if (!failures.includes(error)) failures.push(error);
        scope.closeAdmission(error);
        try { root.lifecycle?.markBlocked("persistence_failed"); }
        catch (failure) { if (!failures.includes(failure)) failures.push(failure); }
        throw error;
      };
      const commandSink = (cleanup?: ClaimIdentity): OwnedCommandLifecycleSink => async event => {
        const commandOwner = cleanup === undefined ? "execution" : JSON.stringify([cleanup.projectId, cleanup.taskId, cleanup.claimId]);
        if (admittedResources.has(event.resourceId) && admittedResources.get(event.resourceId) !== commandOwner) throw new OwnedCommandAdmissionError(new Error("Command reservation conflicts with its original owner."));
        if (event.stage === "prepared" && !admittedResources.has(event.resourceId)) {
          try {
            if (cleanup === undefined) scope.signal.throwIfAborted();
            else if (scope.snapshot().stopped) throw new Error("The original cleanup scope has already settled.");
            if (root.journal === undefined) throw new Error("Worker execution resource journal is not initialized.");
          } catch (error) { throw new OwnedCommandAdmissionError(error); }
          // Re-observing this reservation must remain possible after a failed
          // save closes admission; the journal still checks its original fence.
          admittedResources.set(event.resourceId, commandOwner);
          try {
            if (root.lifecycle !== undefined && lifecycleBinding !== undefined) {
              if (cleanup === undefined) root.lifecycle.reserveExecution({ binding: lifecycleBinding, resourceId: event.resourceId, ownerKind: "repository", identity: { kind: "owned_command" }, operationId: event.resourceId });
              else {
                const current = root.lifecycle.readState();
                if (current.intentVersion === null) throw new OwnedCommandAdmissionError(new Error("The original cleanup authority is unavailable."));
                root.lifecycle.reserveCleanupCommand({ binding: { ...lifecycleBinding, localEpoch: current.localEpoch, intentVersion: current.intentVersion }, task: cleanup, resourceId: event.resourceId });
              }
            }
          } catch (error) {
            // Admission rejection precedes the reservation write. Other failures
            // retain responsibility because their persistence outcome is unknown.
            if (error instanceof LifecycleAdmissionError || error instanceof OwnedCommandAdmissionError) {
              admittedResources.delete(event.resourceId);
              throw error instanceof OwnedCommandAdmissionError ? error : new OwnedCommandAdmissionError(error);
            }
            failCommandPersistence(error);
          }
        }
        try {
          if (root.journal === undefined) throw new Error("Worker execution resource journal is not initialized.");
          await root.journal.sink(scope.generation)(event);
          if (root.lifecycle !== undefined) {
            if (event.stage === "bound") root.lifecycle.recordResource({ resourceId: event.resourceId, stage: "running", processProof: JSON.parse(JSON.stringify(event.proof)) as LifecycleJson });
            if (event.stage === "stopped") root.lifecycle.recordResource({ resourceId: event.resourceId, stage: "stopped", stopProof: { kind: "owned_boundary", sequence: event.sequence }, saveState: "durable" });
            if (event.stage === "unknown") root.lifecycle.recordResource({ resourceId: event.resourceId, stage: "unknown", error: "Original command boundary is unconfirmed." });
          }
        } catch (error) { failCommandPersistence(error); }
      };
      const rebuild = await withOwnedCommandLifecycle(commandSink(), () => {
        const run = () => runWorkerScope(root.manager === undefined ? options : { ...options, onExecutionScope: control => { root.manager!.attach(control); options.onExecutionScope?.(control); } }, root, scope, failures, commandSink);
        return root.lifecycle !== undefined && lifecycleBinding !== undefined ? withWorkerLifecycle({ store: root.lifecycle, binding: lifecycleBinding, failed: error => { scope.closeAdmission(error); try { root.lifecycle!.markBlocked("persistence_failed"); } catch { /* The original persistence failure remains authoritative. */ } } }, run) : run();
      });
      root.manager?.detach();
      if (!rebuild) break;
    }
    while (!cancellation.controller.signal.aborted);
  } finally {
    cancellation.controller.abort();
    await root.ipc?.close();
    await root.manager?.close();
    await root.heartbeat;
    try {
      if (scopes.current() === null || scopes.current() === undefined || scopes.current()?.snapshot().stopped === true) {
        await retireManagementRoot(root);
      }
    } finally { cancellation.dispose(); }
  }
};

const runWorkerScope = async (options: WorkerRunOptions, root: WorkerManagementRoot, scope: ExecutionScope, failures: unknown[], cleanupCommandLifecycle: (identity: ClaimIdentity) => OwnedCommandLifecycleSink): Promise<boolean> => {
  const platform = currentWorkerPlatform();
  const paths = resolveWorkerPaths(options.homeDirectory);
  const cancellation = root.cancellation;
  const managementSignal = cancellation.controller.signal;
  const signal = scope.signal;
  let store = root.store;
  let web: Awaited<ReturnType<typeof createWebRuntime>> | undefined;
  let tools: ReturnType<typeof createWorkerToolSelectionRuntime> | undefined;
  let git: ReturnType<typeof createWorkerGitManager> | undefined;
  let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnostics>> | undefined;
  let configurationDiagnostics: ReturnType<typeof createWorkerConfigurationDiagnostics> | undefined;
  let configuration: WorkerConfigurationManager | undefined;
  let configurationBootstrap: ReturnType<typeof createWorkerConfigurationBootstrap> | undefined;
  let renewal: Promise<void> | undefined;
  let reporter: ReturnType<typeof createWorkerReporter> | undefined;
  let promptSource: ReturnType<typeof createWorkerPromptSource> | undefined;
  let bots: WorkerBotHost | undefined;
  const captureRecovery = (): LifecycleRecoverySources => {
    const stale = <T extends { recoverability: string; reasonCode: unknown }>(items: readonly T[] | undefined) => items?.map(item => item.recoverability === "eligible" ? { ...item, recoverability: "unknown" as const, reasonCode: "resume_interrupted" as const } : item);
    let tasks = root.recoverySources?.tasks, botResults = root.recoverySources?.bots;
    try { tasks = coordinator?.executionSnapshot().recovery ?? stale(tasks); } catch { tasks = stale(tasks); }
    try { botResults = bots?.snapshot().recovery ?? stale(botResults); } catch { botResults = stale(botResults); }
    if (signal.aborted) { tasks = stale(tasks); botResults = stale(botResults); }
    root.recoverySources = { ...(tasks === undefined ? {} : { tasks }), ...(botResults === undefined ? {} : { bots: botResults }) };
    return root.recoverySources;
  };
  root.readRecoverySources = captureRecovery;
  let botRun: Promise<void> | undefined;
  let reviewerRun: Promise<void> | undefined;
  let reviewerSettled = false;
  let readOnly: ReturnType<typeof createWorkerReadOnlyChannel> | undefined;
  let modelDiscovery: ReturnType<typeof createWorkerModelDiscovery> | undefined;
  let initialRemovalReconciliation: Promise<void> | undefined;
  let monitoring: ReturnType<typeof createMonitoringObserver> | undefined;
  let monitoringSender: ReturnType<typeof createMonitoringSender> | undefined;
  const observeMonitoring = (action: (observer: NonNullable<typeof monitoring>) => void): void => {
    if (monitoring !== undefined) try { action(monitoring); } catch { /* Monitoring cannot change worker execution. */ }
  };
  let diagnosticSinkFailure: string | undefined;
  const observeDiagnosticSink = (event: WorkerDiagnosticSinkEvent): void => observeMonitoring(m => {
    if (event.state === "recovered") {
      if (diagnosticSinkFailure !== undefined) m.recover(diagnosticSinkFailure);
      diagnosticSinkFailure = undefined;
    } else {
      diagnosticSinkFailure ??= randomUUID();
      m.fail({ operationId: diagnosticSinkFailure, component: "runtime", phase: `diagnostics-${event.phase}`, scope: { kind: "worker" }, error: event.error,
        retryState: event.nextAttemptAt === null ? "none" : "scheduled", nextAttemptAt: event.nextAttemptAt });
    }
  });
  const localMappingJobs = new Map<string, Promise<void>>();
  const localMappingRetryAt = new Map<string, number>();
  const managementFailures: unknown[] = [];
  const executionFailure = (error: unknown): void => {
    if (isWorkerCancellation(error, signal)) return;
    if (!failures.includes(error)) failures.push(error);
    const commandCleanup = isCommandCleanupFailure(error);
    try {
      diagnostics?.emit({ kind: "reconciliation-error", message: commandCleanup
        ? "An execution owner failed; original command resources remain for reconciliation."
        : "Worker execution stopped after an owner failure; original resources remain for reconciliation.", error });
    } catch (failure) { failures.push(failure); }
    if (!commandCleanup) {
      scope.closeAdmission(error);
      root.lifecycle?.markBlocked("stop_unknown");
    }
  };
  const selectionVerifier = createNativeSelectionVerifier();
  const directoryBrowser = createWorkerDirectoryBrowser();
  let requestRebuild: (() => void) | undefined;
  let rebuildRequested = false;
  let ownerResults: OwnerStopResult[] = [];
  let startupWork: Promise<() => Promise<void>> | undefined;
  let startupSettled = false;
  const joinStartup = async (): Promise<void> => { await Promise.allSettled([startupWork]); };
  const registerOwner = (owner: Parameters<ExecutionScope["register"]>[0]): void => scope.register({ ...owner,
    stop: async options => { await joinStartup(); await owner.stop(options); },
  });
  let controlPublished = false;
  const publishControl = (): void => {
    if (controlPublished) return;
    controlPublished = true;
    options.onExecutionScope?.({ generation: scope.generation, snapshot: scope.snapshot,
      stop: async options => ownerResults = await scope.stop(options),
      reconcile: async options => ownerResults = await scope.reconcile(options),
      rebuild: () => {
        if (!scope.snapshot().stopped) throw new Error("Execution scope cannot rebuild before all original resources are confirmed stopped.");
        rebuildRequested = true; requestRebuild!();
      },
    });
  };
  const rebuilding = new Promise<void>(resolve => { requestRebuild = resolve; });
  const resolvedCommandCleanup = (error: unknown): boolean => error instanceof OwnedCommandCleanupError
    ? !hasUnconfirmedOwnedCommandCleanup(error)
    : error instanceof AggregateError && error.errors.length > 0 && error.errors.every(resolvedCommandCleanup)
      && (error.cause === undefined || resolvedCommandCleanup(error.cause));
  const unresolvedProducerFailures = (errors: readonly unknown[]): unknown[] => errors.filter(error => {
    if (!resolvedCommandCleanup(error)) return true;
    if (!failures.includes(error)) failures.push(error);
    return false;
  });
  const join = async (jobs: readonly (Promise<unknown> | undefined)[]): Promise<void> => {
    const results = await Promise.allSettled(jobs);
    throwFailures(unresolvedProducerFailures(results.flatMap(result => result.status === "rejected" ? [result.reason] : [])));
  };
  let configurationManagerStop: Promise<void> | undefined;
  const stopConfigurationManager = (): Promise<void> => {
    if (configurationManagerStop !== undefined) return configurationManagerStop;
    const work = Promise.resolve().then(() => configuration?.stop());
    configurationManagerStop = work;
    void work.catch(() => { if (configurationManagerStop === work) configurationManagerStop = undefined; });
    return work;
  };
  let probeStop: Promise<void> | undefined;
  const stopProbes = (): Promise<void> => {
    if (probeStop !== undefined) return probeStop;
    const work = (async () => {
      // Configuration jobs publish their final saved results through the tool
      // manager. Keep it open until those publishers join; its own owner still
      // reports any failure, and independent probe cleanup must also proceed.
      try { await stopConfigurationManager(); }
      catch (error) { if (!failures.includes(error)) failures.push(error); }
      await join([selectionVerifier.close(), tools?.close()]);
    })();
    probeStop = work;
    void work.catch(() => { if (probeStop === work) probeStop = undefined; });
    return work;
  };
  let repositoryStop: Promise<void> | undefined;
  const stopRepository = (): Promise<void> => {
    if (repositoryStop !== undefined) return repositoryStop;
    const work = Promise.resolve().then(() => git?.dispose());
    repositoryStop = work;
    void work.catch(() => { if (repositoryStop === work) repositoryStop = undefined; });
    return work;
  };
  let reportDrain: Promise<void> | undefined;
  let reportFailure: unknown;
  const stopReporter = (): Promise<void> => reportDrain ??= Promise.resolve().then(() => reporter?.stop()).then(() => { root.executionReporterActive = false; }).catch(error => { reportFailure = error; });
  const drainReport = (): Promise<void> => {
    if (!managementSignal.aborted) return Promise.resolve();
    return stopReporter();
  };
  let taskStop: Promise<void> | undefined;
  const stopTasks = (deadline: number): Promise<void> => {
    if (taskStop !== undefined) return taskStop;
    const work = (async () => {
      if (coordinator !== undefined && !await coordinator.shutdown({ deadline })) throw new Error("Some original task resources remain unconfirmed.");
    })();
    taskStop = work;
    void work.catch(() => { if (taskStop === work) taskStop = undefined; });
    return work;
  };
  let configurationStop: Promise<void> | undefined;
  const stopConfiguration = (): Promise<void> => {
    if (configurationStop !== undefined) return configurationStop;
    const work = (async () => {
      await drainReport();
      await join([stopConfigurationManager(), configurationBootstrap?.stop(), initialRemovalReconciliation?.catch(error => { if (!isWorkerCancellation(error, signal)) throw error; }), ...localMappingJobs.values(), readOnly?.join(), modelDiscovery?.join(), directoryBrowser.join()]);
      promptSource?.close();
    })();
    configurationStop = work;
    void work.catch(() => { if (configurationStop === work) configurationStop = undefined; });
    return work;
  };
  const stopReviewer = async (): Promise<void> => {
    try { await reviewerRun; }
    catch (error) {
      await reconcileReviewerHostFailure(error);
      if (!failures.includes(error)) failures.push(error);
    }
  };
  registerOwner({ resourceId: "configuration", ownerKind: "configuration",
    closeAdmission: () => { configuration?.beginDrain(); readOnly?.close(); modelDiscovery?.close(); directoryBrowser.close(); },
    snapshot: () => ({ directory: directoryBrowser.snapshot(), mappings: localMappingJobs.size }), stop: stopConfiguration });
  registerOwner({ resourceId: "tasks", ownerKind: "task",
    closeAdmission: reason => coordinator?.closeAdmission?.(reason), snapshot: () => coordinator?.executionSnapshot?.(),
    stop: ({ deadline }) => stopTasks(deadline) });
  registerOwner({ resourceId: "bots", ownerKind: "bot",
    closeAdmission: reason => bots?.closeAdmission(reason), snapshot: () => bots?.snapshot(),
    stop: async ({ deadline }) => { await bots?.shutdown({ deadline }); await botRun; captureRecovery(); await bots?.close(); } });
  registerOwner({ resourceId: "reviewer", ownerKind: "assistant",
    snapshot: () => ({ started: reviewerRun !== undefined, settled: reviewerSettled }),
    stop: stopReviewer });
  registerOwner({ resourceId: "probes", ownerKind: "probe",
    stop: stopProbes });
  registerOwner({ resourceId: "repository", ownerKind: "repository", stop: async ({ deadline }) => {
    // A Task stop deadline only bounds observation. Its original terminal writer
    // can still remove a worktree, so unconfirmed closure must retain Git too.
    await stopTasks(deadline);
    await drainReport();
    await stopRepository();
  } });
  registerOwner({ resourceId: "native-inventory", ownerKind: "repository", snapshot: () => root.journal?.snapshot(), stop: async ({ deadline }) => {
    // Reconcile known boundaries before joining Task writers. The final read
    // also covers cleanup commands those writers admitted after scope closure.
    const originalCommands = await Promise.allSettled([root.journal?.reconcileRetained({ generation: scope.generation, deadline })]);
    const taskStop = await Promise.allSettled([stopTasks(deadline)]);
    const cleanupCommands = await Promise.allSettled([root.journal?.reconcileRetained({ generation: scope.generation, deadline })]);
    const receipts = await Promise.allSettled([synchronizeCommandStopReceipts(root)]);
    throwFailures([...originalCommands, ...taskStop, ...cleanupCommands, ...receipts].flatMap(result => result.status === "rejected" ? [result.reason] : []));
    if (retainedOwnedCommandBoundaries().length) throw new Error("Original native command boundaries remain unconfirmed.");
  } });
  let archiveStop: Promise<void> | undefined;
  const stopArchive = (): Promise<void> => archiveStop ??= (async () => {
    await renewal;
    // close joins all writers before reporting historical upload failures.
    try { await web?.archiveMaintenance.close(); } catch (error) { failures.push(error); }
  })();
  registerOwner({ resourceId: "archive", ownerKind: "controller", stop: stopArchive });
  registerOwner({ resourceId: "controllers", ownerKind: "controller", stop: async ({ deadline }) => {
    // Controller storage remains owned until original task writers have joined.
    await stopTasks(deadline);
    await stopConfiguration();
    await stopArchive();
    captureRecovery();
    await web?.jobLeases.close();
    web?.webBackend.closeInput();
    web?.webStore.close();
  } });
  scope.register({ resourceId: "startup", ownerKind: "configuration",
    snapshot: () => ({ settled: startupSettled }), stop: joinStartup });
  const initialize = async (): Promise<() => Promise<void>> => {
    signal.throwIfAborted();
    const local = await readWorkerLocalConfiguration(paths, signal);
    signal.throwIfAborted();
    if (local.agentControlMode === "herdr") throw new Error("worker.agentControlMode herdr is no longer supported; remove it or set it to web in the local configuration.");
    const { serverUrl, serverToken } = local;
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    root.lock ??= await acquireWorkerInstanceLock(paths);
    signal.throwIfAborted();
    monitoring = createMonitoringObserver();
    signal.throwIfAborted();
    const workerId = await ensureWorkerIdentity(paths, signal);
    await mkdir(paths.temporaryDirectory, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken], onSinkState: observeDiagnosticSink });
    signal.throwIfAborted();
    const currentDiagnostics = diagnostics, emit = currentDiagnostics.emit;
    configurationDiagnostics = createWorkerConfigurationDiagnostics({ emit });
    const remote = createWorkerRemote({ serverUrl, serverToken });
    const invalidateUnavailable = (projectId?: string): void => {
      reporter?.publishInventory(null);
      if (projectId !== undefined) coordinator?.invalidateProject?.(projectId);
    };
    const resolveProject: typeof remote.resolveProject = async (repository, operationSignal) => {
      try { return await remote.resolveProject(repository, operationSignal); }
      catch (error) {
        if (projectUnavailable(error)) invalidateUnavailable(repository.projectId ?? (error instanceof ApiError ? error.projectId : undefined));
        throw error;
      }
    };
    const userId = await verifyWorkerPrincipal(() => remote.currentUserId(signal), signal, configurationDiagnostics.exchange);
    signal.throwIfAborted();
    const identity = { serverOrigin: serverUrl, userId, workerId };
    if (root.identity !== undefined && !isDeepStrictEqual(root.identity, identity)) throw new Error("Worker management identity changed across execution scopes.");
    root.identity ??= identity;
    root.journal ??= await openExecutionResourceJournal({ directory: path.join(paths.workerDirectory, "execution-resources"), identity });
    signal.throwIfAborted();
    await withinExecutionDeadline(root.journal.assertClosed(), Date.now() + 10_000);
    signal.throwIfAborted();
    const observer = monitoring;
    monitoringSender = createMonitoringSender({ capture: observer.capture,
      write: (observation, operation, requestId) => remote.writeMonitoring(workerId, observation, operation, requestId),
      deliverySuccess: observer.deliverySuccess, deliveryFailure: observer.deliveryFailure, emit });
    observeMonitoring(m => m.setPhase("configuration"));
    const currentPromptSource = createWorkerPromptSource({ serverOrigin: serverUrl, userId, workerId });
    promptSource = currentPromptSource;
    const readCloudConfiguration = async (readSignal: AbortSignal, operation?: Operation): Promise<ReceivedWorkerConfigurationResource> => {
      try { return operation === undefined ? await remote.configuration(workerId, readSignal) : await remote.configuration(workerId, readSignal, operation); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) throw error;
        return { json: '{"desired":null,"observationRevision":"0","observation":null}', desired: null, observationRevision: "0", observationJson: null };
      }
    };
    let resource: ReceivedWorkerConfigurationResource | undefined;
    const initialSyncId = randomUUID();
    configurationDiagnostics.exchange({ syncId: initialSyncId, phase: "authority-read", status: "started", source: null, remoteOutcome: "not_sent", localOutcome: "not_attempted" });
    try {
      resource = await readCloudConfiguration(signal);
      configurationDiagnostics.exchange({ syncId: initialSyncId, phase: "authority-read", status: "succeeded", source: null, remoteOutcome: "success", localOutcome: "pending", received: { desiredRevision: resource.desired?.revision ?? null, observationRevision: resource.observationRevision } });
    }
    catch (error) {
      const requestId = workerConfigurationRequestId(error);
      configurationDiagnostics.exchange({ syncId: initialSyncId, phase: "authority-read", status: "failed", source: null, remoteOutcome: failedConfigurationRequestOutcome(error), localOutcome: "not_attempted", ...(requestId === undefined ? {} : { requestId }), error });
      if (!isWorkerCancellation(error, signal)) observeMonitoring(m => {
        m.setAdmission("partial", [{ code: "configuration-unavailable", scope: { kind: "worker" }, observedAt: new Date().toISOString(), nextAttemptAt: null }]);
        m.fail({ operationId: randomUUID(), component: "configuration", phase: "configuration", scope: { kind: "worker" }, error });
      });
      if (signal.aborted || !transientAuthorityFailure(error)) throw error;
    }
    signal.throwIfAborted();
    const machine = machineDescription(platform);
    const prepared = new Map<string, WorkerProject>();
    const locallyKnownIds = new Set(workerLocalExplicitProjectIds(local, paths));
    const unboundMappings = new Map<string, number>(workerLocalUnboundRepositoryIndexes(local, paths).map(index => [`legacy:${index}`, index]));
    // Local mappings can retain Git-only owners even after cloud selection changes.
    const unobservedLocalMappings = new Set([...locallyKnownIds, ...unboundMappings.keys()]);
    const confirmedNoLocalMapping = new Set<string>();
    const getStore = (): ReturnType<typeof openWorkerStore> => store === undefined ? (root.store = store = openWorkerStore(paths.databaseFile)) : store;
    const getGit = (): ReturnType<typeof createWorkerGitManager> => git === undefined ? (git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory, reportPending: gitPendingReporter(emit), reportSettled: gitSettledReporter(emit), reportHolderTerminated: holderTerminatedReporter(emit),
      readCleanupPolicy: () => configuration?.readCleanupPolicy() ?? null,
      prepareFormat: (project, repository, operation) => prepareWorkerWorktreeFormat({ paths, store: getStore(), project, repository, operation, workerId, serverOrigin: serverUrl, verifyWebUnregistered: createWorkerSessionApi(serverUrl, serverToken).verifyUnregistered }),
    })) : git;
    const { admit: admitRepository } = createWorkerRepositoryAdmission({ paths, store: getStore, workerId, serverOrigin: serverUrl });
    const admitLocalBinding = async (binding: WorkerProject, operationSignal: AbortSignal): Promise<WorkerProject> => {
      unobservedLocalMappings.add(binding.projectId);
      try {
        const existing = getStore().getProject(binding);
        if (existing !== null && (existing.repoUrl !== binding.repoUrl || existing.localPath !== binding.localPath)) throw new Error(`Project ${binding.projectId} has a different retained repository binding.`);
        const admitted = await admitRepository(binding, operationSignal);
        unobservedLocalMappings.delete(binding.projectId);
        return admitted;
      } catch (error) { reporter?.publishInventory(null); throw error; }
    };
    const reservations = new Map<string, string>();
    let reservationTail: Promise<void> = Promise.resolve();
    const reserveRepository = (binding: WorkerProject, applicationSignal: AbortSignal): Promise<void> => {
      const reservation = reservationTail.then(async () => {
        applicationSignal.throwIfAborted();
        if (reservations.has(binding.projectId)) throw new Error(`Project ${binding.projectId} already has a repository preparation in progress.`);
        const retained = getStore().listProjects().filter(project => project.projectId !== binding.projectId);
        const retainedIds = new Set(retained.map(project => project.projectId));
        await validateWorkerRepositoryLocations([...retained.map(value => ({ path: value.localPath })), ...[...reservations].filter(([projectId]) => !retainedIds.has(projectId)).map(([, value]) => ({ path: value })), { path: binding.localPath }], paths, applicationSignal);
        applicationSignal.throwIfAborted();
        reservations.set(binding.projectId, binding.localPath);
      });
      reservationTail = reservation.then(() => undefined, () => undefined);
      return reservation;
    };
    const bindingJobs = new Map<string, { signal: AbortSignal; job: Promise<WorkerProject> }>();
    const resolveBinding = (projectId: string, applicationSignal: AbortSignal): Promise<WorkerProject> => {
      const existing = bindingJobs.get(projectId);
      if (existing !== undefined && existing.signal === applicationSignal && !existing.signal.aborted) return existing.job;
      const job = (async () => {
        const currentStore = getStore();
        let previous = currentStore.getProject({ projectId });
        if (previous === null) {
          unobservedLocalMappings.add(projectId);
          let localMapping;
          try { localMapping = await workerLocalRepositoryForId(local, paths, projectId); }
          catch (error) { unobservedLocalMappings.add(projectId); reporter?.publishInventory(null); throw error; }
          applicationSignal.throwIfAborted();
          if (localMapping !== undefined) previous = await admitLocalBinding({ projectId, repoUrl: localMapping.remote, localPath: localMapping.path }, applicationSignal);
          else if (![...unboundMappings.keys()].some(key => unobservedLocalMappings.has(key))) {
            confirmedNoLocalMapping.add(projectId);
            unobservedLocalMappings.delete(projectId);
          }
        }
        let project;
        try { project = await remote.project(projectId, applicationSignal); }
        catch (error) { if (projectUnavailable(error)) invalidateUnavailable(projectId); throw error; }
        const mapped = previous === null ? await workerLocalRepositoryForProject(local, paths, project) : undefined;
        applicationSignal.throwIfAborted();
        if (previous === null && mapped !== undefined) previous = await admitLocalBinding({ projectId, repoUrl: mapped.remote, localPath: mapped.path }, applicationSignal);
        else if (previous === null) {
          confirmedNoLocalMapping.add(projectId);
          unobservedLocalMappings.delete(projectId);
        }
        if (previous !== null) await resolveProject({ repoUrl: previous.repoUrl, projectId }, applicationSignal);
        const root = resolveRepositoryRoot(local.repositoryRoot, paths, options.homeDirectory, "worker.repositoryRoot");
        return previous ?? { projectId, repoUrl: mapped?.remote ?? project.repoUrl, localPath: mapped?.path ?? repositoryLocation(project.repoUrl, root) };
      })();
      bindingJobs.set(projectId, { signal: applicationSignal, job });
      void job.finally(() => { if (bindingJobs.get(projectId)?.job === job) bindingJobs.delete(projectId); }).catch(() => undefined);
      return job;
    };
    const nativeApplication = nativeConfigurationApplication({ tools: () => tools, paths, homeDirectory: options.homeDirectory, workingDirectory: options.workingDirectory, overrides: local, signal, emit });
    const toolEnvironment = { agentEnvironment: { DN_CONFIG_DIR: paths.stateDirectory } };
    tools = createWorkerToolSelectionRuntime({ workerDirectory: paths.workerDirectory, cwd: options.workingDirectory, environment: { ...process.env, ...toolEnvironment.agentEnvironment }, localToolPaths: local.toolPaths,
      readActiveSelections: () => [...webToolSelections(options.homeDirectory, web), ...bots?.activeToolSelections() ?? []] });
    const toolRuntime = tools;
    let retainedView: WorkerCoordinatorConfiguration | undefined;
    const view = (snapshot: WorkerConfigurationSnapshot): WorkerCoordinatorConfiguration | null => {
      const taskTagFilter = snapshot.effective.taskTagFilterKey === undefined ? {} : { taskTagFilterKey: snapshot.effective.taskTagFilterKey };
      if (snapshot.selectedProjects === null) {
        if (retainedView !== undefined) {
          const { taskTagFilterKey: _previousFilter, ...retained } = retainedView;
          return { ...retained, ...taskTagFilter };
        }
        const projects = getStore().listProjects().map(project => project.projectId);
        return projects.length === 0 ? null : { repositories: [], targetProjectIds: projects, readyProjectIds: projects, globalConfiguration: null, maxConcurrent: 1, preferPlatformSpecificTasks: false,
          ...taskTagFilter,
          ...(snapshot.retainedRecoveryLimit === null ? {} : { recoveryLimit: snapshot.retainedRecoveryLimit }) };
      }
      const effective = snapshot.effective;
      if (effective.maxConcurrent === null || effective.recoveryLimit === null || effective.preferPlatformSpecificTasks === null) return null;
      const repositories: WorkerRepositoryAssignment[] = [];
      for (const project of effective.projects) {
        const binding = prepared.get(project.projectId);
        if (project.ready && project.native !== null && binding !== undefined) repositories.push({ project: binding, configuration: effectiveExecutionConfiguration(project.native, effective.recoveryLimit, local) });
      }
      retainedView = { repositories, targetProjectIds: snapshot.selectedProjects.map(project => project.projectId), readyProjectIds: effective.projects.filter(project => project.ready && prepared.has(project.projectId)).map(project => project.projectId), globalConfiguration: effective.native === null ? null : effectiveExecutionConfiguration(effective.native, effective.recoveryLimit, local), maxConcurrent: effective.maxConcurrent, recoveryLimit: effective.recoveryLimit, preferPlatformSpecificTasks: effective.preferPlatformSpecificTasks, ...taskTagFilter };
      return retainedView;
    };
    const transitions = new Map<string, string>();
    const preparationFailures = new Map<string, { operationId: string; observedAt: string; revision: string; successRevision: string | null }>();
    const nativeFailures = new Map<string, { operationId: string; observedAt: string; target: WorkerCloudNative }>();
    const nativeActivities = new Map<string, { operationId: string; revision: string }>();
    let monitoringTargetSignature: string | undefined;
    let effectiveSignature = "";
    const reconcileWake = createReconcileWake();
    let scheduleInitialRemovals: (() => void) | undefined;
    let configurationStorageFailure: string | undefined;
    configuration = await createWorkerConfigurationManager({
      file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal, localToolPaths: local.toolPaths,
      ...toolRuntime.configurationOptions, applyNative: nativeApplication.apply,
      onApplication: configurationDiagnostics.application,
      onStorageState: event => {
        const observedAt = new Date().toISOString();
        observeMonitoring(m => {
          if (event.kind === "recovered") {
            if (configurationStorageFailure !== undefined) m.recover(configurationStorageFailure);
            configurationStorageFailure = undefined;
          } else {
            configurationStorageFailure ??= randomUUID();
            m.fail({ operationId: configurationStorageFailure, component: "configuration", phase: `cache-${event.phase}`, scope: { kind: "worker" }, error: new ConfigurationFileOperationError(event.phase, event.error),
              retryState: event.nextAttemptAt === null ? "none" : "scheduled", nextAttemptAt: event.nextAttemptAt });
            m.setAdmission("partial", [{ code: "configuration-unavailable", scope: { kind: "worker" }, observedAt, nextAttemptAt: event.nextAttemptAt }]);
          }
        });
        configurationDiagnostics!.storage(event);
        if (event.kind === "recovered") { reporter?.trigger(); reconcileWake.request(); }
      },
      onNativeApplication: event => {
        const projectId = event.key.kind === "projectNative" ? event.key.projectId : null;
        const key = projectId === null ? "native" : `project/${projectId}`;
        const scope = projectId === null ? { kind: "worker" as const } : { kind: "project" as const, projectId };
        const failure = nativeFailures.get(key);
        if (event.kind === "started") {
          if (failure !== undefined && isDeepStrictEqual(failure.target, event.target)) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "running"); m.setNativeConfigurationReason(scope, { observedAt: failure.observedAt, nextAttemptAt: null }); });
          observeMonitoring(m => { const operationId = m.startActivity({ kind: "maintenance", phase: "configuration", scope }); nativeActivities.set(key, { operationId, revision: event.revision }); });
          return;
        }
        const activity = nativeActivities.get(key);
        if (activity?.revision === event.revision) { observeMonitoring(m => m.endActivity(activity.operationId)); nativeActivities.delete(key); }
        if (event.kind === "cancelled") {
          if (failure !== undefined && isDeepStrictEqual(failure.target, event.target)) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setNativeConfigurationReason(scope, { observedAt: failure.observedAt, nextAttemptAt: null }); });
          return;
        }
        const current = configuration?.current(), item = current?.items.find(value => value.key.kind === event.key.kind && (event.key.kind === "native" || "projectId" in value.key && value.key.projectId === event.key.projectId));
        if (item?.targetRevision !== event.revision) return;
        if (event.kind === "failed") {
          const observedAt = new Date().toISOString(), operationId = failure?.operationId ?? randomUUID();
          nativeFailures.set(key, { operationId, observedAt, target: event.target });
          observeMonitoring(m => { m.fail({ operationId, component: "configuration", phase: "configuration", scope, error: event.error, retryState: "scheduled", nextAttemptAt: event.nextAttemptAt }); m.setNativeConfigurationReason(scope, { observedAt, nextAttemptAt: event.nextAttemptAt }); });
        } else if (item.state === "applied" && failure !== undefined && isDeepStrictEqual(failure.target, event.target)) {
          observeMonitoring(m => { m.recover(failure.operationId); m.setNativeConfigurationReason(scope, null); }); nativeFailures.delete(key);
        }
      },
      onChange: snapshot => {
        toolRuntime.setTargets(snapshot.toolTargets);
        const targetSignature = JSON.stringify(snapshot.desired?.value ?? null);
        if (monitoringTargetSignature !== targetSignature) { monitoringTargetSignature = targetSignature; observeMonitoring(m => m.invalidateAdmission()); }
        const incomplete = snapshot.selectedProjects === null
          ? true
          : snapshot.effective.native === null || snapshot.selectedProjects.some(project => {
            const effective = snapshot.effective.projects.find(value => value.projectId === project.projectId);
            return effective === undefined || !effective.ready || effective.native === null || !prepared.has(project.projectId);
          });
        observeMonitoring(m => m.setProjectPreparationIncomplete(incomplete));
        if (snapshot.selectedProjects !== null) observeMonitoring(m => m.setProjectPreparationUnknown(false));
        const selectedProjects = snapshot.selectedProjects === null ? null : new Set(snapshot.selectedProjects.map(project => project.projectId));
        if (selectedProjects !== null && snapshot.desired !== null) for (const [key, failure] of nativeFailures) {
          const projectId = key.startsWith("project/") ? key.slice("project/".length) : null;
          const project = projectId === null ? undefined : snapshot.selectedProjects?.find(value => value.projectId === projectId);
          const target = snapshot.desired === null ? null : projectId === null ? snapshot.desired.value.native : project === undefined ? null : resolveWorkerCloudProjectNative(snapshot.desired.value.native, project);
          if (target === null || !isDeepStrictEqual(target, failure.target)) {
            const scope = projectId === null ? { kind: "worker" as const } : { kind: "project" as const, projectId };
            observeMonitoring(m => { m.discardFailure(failure.operationId); m.setNativeConfigurationReason(scope, null); });
            nativeFailures.delete(key);
          }
        }
        if (selectedProjects !== null) for (const [projectId, failure] of preparationFailures) {
          if (!selectedProjects.has(projectId)) {
            observeMonitoring(m => { m.discardFailure(failure.operationId); m.setProjectPreparationReason(projectId, null); });
            preparationFailures.delete(projectId);
            continue;
          }
          const item = snapshot.items.find(value => value.key.kind === "projectPreparation" && value.key.projectId === projectId);
          if (item === undefined) { failure.successRevision = null; continue; }
          if (failure.successRevision !== null && failure.successRevision !== item.targetRevision) failure.successRevision = null;
          if (item.state === "applied" && failure.successRevision === item.targetRevision) {
            observeMonitoring(m => { m.recover(failure.operationId); m.setProjectPreparationReason(projectId, null); });
            preparationFailures.delete(projectId);
          } else if (item.state === "error" && item.targetRevision === failure.revision && item.nextAttemptAt !== null) {
            observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "scheduled", item.nextAttemptAt); m.setProjectPreparationReason(projectId, { observedAt: failure.observedAt, nextAttemptAt: item.nextAttemptAt }); });
          } else if (item.state === "pending") {
            observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setProjectPreparationReason(projectId, { observedAt: failure.observedAt, nextAttemptAt: null }); });
          }
        }
        if (snapshot.selectedProjects !== null) for (const project of snapshot.selectedProjects) {
          if (getStore().getProject({ projectId: project.projectId }) === null && !confirmedNoLocalMapping.has(project.projectId)) unobservedLocalMappings.add(project.projectId);
        }
        const signature = JSON.stringify(snapshot.effective);
        if (signature !== effectiveSignature) { effectiveSignature = signature; reporter?.publishInventory(null); reconcileWake.request(); }
        const current = view(snapshot);
        if (current !== null) coordinator?.updateConfiguration(current);
        else if (snapshot.selectedProjects !== null) {
          retainedView = { repositories: [], targetProjectIds: snapshot.selectedProjects.map(project => project.projectId), readyProjectIds: [], globalConfiguration: null, maxConcurrent: snapshot.effective.maxConcurrent ?? 1, preferPlatformSpecificTasks: false,
            ...(snapshot.effective.taskTagFilterKey === undefined ? {} : { taskTagFilterKey: snapshot.effective.taskTagFilterKey }) };
          coordinator?.updateConfiguration(retainedView);
        }
        scheduleInitialRemovals?.();
        for (const item of snapshot.items) {
          const key = JSON.stringify(item.key), state = JSON.stringify([item.targetRevision, item.state, item.error]);
          if (transitions.get(key) === state) continue;
          transitions.set(key, state);
          emit({ kind: "worker-configuration", message: JSON.stringify({ desiredRevision: snapshot.desiredRevision, key: item.key, targetRevision: item.targetRevision, state: item.state, error: item.error }) });
        }
      },
      onError: executionFailure,
      onInvalidDesired: (revision, reason) => emit({ kind: "warning", message: reason === "unsupported_configuration" ? `Worker configuration revision ${revision} is missing required settings or contains unsupported current values; correct the target before applying it.`
          : `Worker configuration revision ${revision} exceeds current limits; waiting for a valid target while retaining application results.` }),
    });
    signal.throwIfAborted();
    if (resource !== undefined) {
      const previous = configuration.current();
      await configuration.receive(resource.desired, resource.observationRevision, signal, initialSyncId, resource.observationJson === null ? null : { observationRevision: resource.observationRevision, json: resource.observationJson });
      const current = configuration.current();
      configurationDiagnostics.exchange({ syncId: initialSyncId, phase: "authority-read", status: "succeeded", remoteOutcome: "success", localOutcome: "persisted",
        source: { state: current.desiredRevision === null ? "uninitialized" : "initialized", generation: current.generation, desiredRevision: current.desiredRevision, observationRevision: current.observationRevision },
        previousSource: { state: "unread", generation: previous.generation, desiredRevision: previous.desiredRevision, observationRevision: previous.observationRevision },
        received: { desiredRevision: resource.desired?.revision ?? null, observationRevision: resource.observationRevision } });
    }
    signal.throwIfAborted();
    const manager = configuration;
    const proofSignature = () => JSON.stringify(([ ["codex", "web"], ["copilot", "web"] ] as const).map(([tool, context]) => toolRuntime.manager.currentSelection(tool, context)?.selectionKey));
    let observedToolProof = proofSignature();
    const refreshToolProofs = (): Promise<void> | undefined => {
      const current = proofSignature(); if (current === observedToolProof) return;
      observedToolProof = current; return manager.refreshToolSelections(signal);
    };
    const readOnlyConfiguration = createWorkerReadOnlyConfiguration({ current: () => manager.current(), local,
      selection: tool => {
        const launch = toolRuntime.manager.currentSelection(tool, "web");
        return launch === undefined ? undefined : { selectionKey: launch.selectionKey, revision: toolRuntime.inspector.revision(launch) };
      } });
    modelDiscovery = createWorkerModelDiscovery({
      prepare: async (provider, operation) => { if (provider === "codex" || provider === "copilot") await toolRuntime.manager.prepare(provider, "web", operation); },
      defaultCwd: options.workingDirectory, environment: { ...process.env, ...toolEnvironment.agentEnvironment }, verifier: { discover: async (input, operation) => {
        if (input.native.agent !== "codex" && input.native.agent !== "copilot") return selectionVerifier.discover(input, operation);
        const toolLaunch = await toolRuntime.manager.selectForNewExecution(input.native.agent, "web", operation);
        return toolRuntime.inspector.discover({ ...input, toolLaunch, toolRuntimeRoot: toolRuntime.toolRuntimeRoot }, operation);
      } },
      configuration: readOnlyConfiguration.modelConfiguration,
    });
    const executeReadOnly = async <K extends WorkerReadOnlyOperation>(operation: K, input: WorkerReadOnlyOperations[K]["input"], requestSignal: AbortSignal): Promise<WorkerReadOnlyOperations[K]["result"]> => {
      const result = operation === "directory.list"
        ? await directoryBrowser(input as WorkerDirectoryInput, { defaultCwd: options.workingDirectory, signal: requestSignal })
        : await modelDiscovery!.discover(input as WorkerModelInput, requestSignal);
      return result as WorkerReadOnlyOperations[K]["result"];
    };
    readOnly = createWorkerReadOnlyChannel({ serverOrigin: serverUrl, serverToken, ownerUserId: userId, workerId,
      configurationSignature: readOnlyConfiguration.channelSignature,
      execute: executeReadOnly,
      onInvalidate: () => modelDiscovery?.invalidate(),
      onError: message => emit({ kind: "worker-readonly", message }),
    });
    const scheduleLocalMappingChecks = (): void => {
      for (const projectId of unobservedLocalMappings) {
        if (localMappingJobs.has(projectId) || (localMappingRetryAt.get(projectId) ?? 0) > Date.now()) continue;
        const unboundIndex = unboundMappings.get(projectId);
        const selectedProjects = manager.current().selectedProjects;
        if (unboundIndex === undefined && !locallyKnownIds.has(projectId) && (selectedProjects === null || selectedProjects.some(project => project.projectId === projectId))) continue;
        const job = (async () => {
          if (unboundIndex !== undefined) {
            const mapping = await workerLocalUnboundRepository(local, paths, unboundIndex);
            signal.throwIfAborted();
            const matches = getStore().listProjects().filter(project => repositoryIdentity(project.repoUrl) === repositoryIdentity(mapping.remote));
            if (matches.length > 1) throw new Error("An unbound local repository matches multiple retained project bindings.");
            if (matches.length === 1) {
              if (matches[0]!.localPath !== mapping.path) throw new Error("An unbound local repository conflicts with its retained project binding.");
            } else {
              try { await lstat(mapping.path); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") { unobservedLocalMappings.delete(projectId); return; }
                throw error;
              }
              if (mapping.invalidProjectId) {
                throw new Error("A local repository with an invalid Project ID cannot be prepared for resource observation.");
              }
              const project = await resolveProject({ repoUrl: mapping.remote }, signal);
              const operation = createOperation({ signal });
              try {
                const candidate = { projectId: project.id, repoUrl: mapping.remote, localPath: mapping.path };
                await getGit().prepareRepository(candidate, operation);
                const scan = await getGit().scanWorktrees(candidate, operation, false, true);
                if (!scan.enumerationComplete || scan.unknown.length > 0) throw scan.unknown[0]?.error ?? new Error("Local repository resource coverage is incomplete.");
                if ([...scan.validated, ...scan.quarantined].some(({ owner }) => owner.projectId !== project.id)) throw new Error("An unbound local repository contains resources owned by another Project.");
                // Mapping admission proves the project/path association only. The
                // coordinator independently proves quarantined owners before claiming.
              } finally { operation.dispose(); }
              await admitLocalBinding({ projectId: project.id, repoUrl: mapping.remote, localPath: mapping.path }, signal);
            }
            unobservedLocalMappings.delete(projectId);
          } else if (locallyKnownIds.has(projectId)) {
            const mapping = await workerLocalRepositoryForId(local, paths, projectId);
            signal.throwIfAborted();
            if (mapping === undefined) throw new Error(`The local repository mapping for ${projectId} disappeared.`);
            await admitLocalBinding({ projectId, repoUrl: mapping.remote, localPath: mapping.path }, signal);
          } else await resolveBinding(projectId, signal);
        })().catch(error => {
          if (!signal.aborted) {
            localMappingRetryAt.set(projectId, Date.now() + 5_000);
            emit({ kind: "warning", message: `Local resource mapping for project ${projectId} remains unobserved.`, error });
          }
        }).finally(() => { localMappingJobs.delete(projectId); });
        localMappingJobs.set(projectId, job);
      }
    };
    let initialRemovalsComplete = false;
    let initialRemovalsJob: Promise<void> | undefined;
    // A reset invalidates an awaiting pass even if usable authority returns before it resumes.
    let initialRemovalsEpoch = {};
    // Keep progress across capacity retries, but require a new coordinator to observe each binding again.
    const initialRemovalsRegistered = new Set<string>();
    const ensureInitialRemovals = (): Promise<void> => {
      const current = manager.current();
      if (current.selectedProjects === null) {
        initialRemovalsEpoch = {};
        initialRemovalsComplete = false;
        initialRemovalsRegistered.clear();
        return Promise.resolve();
      }
      if (initialRemovalsComplete) return Promise.resolve();
      if (initialRemovalsJob !== undefined) return initialRemovalsJob;
      const epoch = initialRemovalsEpoch;
      const job = (async () => {
        for (const project of getStore().listProjects()) {
          signal.throwIfAborted();
          if (epoch !== initialRemovalsEpoch) return;
          if (initialRemovalsRegistered.has(project.projectId)) continue;
          const accepted = await manager.ensureProjectRemoval(project.projectId, signal);
          if (epoch !== initialRemovalsEpoch) return;
          if (!accepted) { initialRemovalsRegistered.clear(); return; }
          initialRemovalsRegistered.add(project.projectId);
        }
        const latest = manager.current();
        if (epoch !== initialRemovalsEpoch) return;
        if (latest.selectedProjects === null) { initialRemovalsRegistered.clear(); return; }
        initialRemovalsComplete = true;
      })();
      initialRemovalsJob = job;
      initialRemovalReconciliation = job;
      void job.finally(() => { if (initialRemovalsJob === job) initialRemovalsJob = undefined; }).catch(() => undefined);
      return job;
    };
    const copilotRequired = (): boolean => {
      const effective = manager.current().effective;
      return effective.native?.agent === "copilot" || effective.projects.some(project => project.native?.agent === "copilot") || (bots?.requiresCopilot() ?? false);
    };
    bots = createWorkerBotHost({ ...options, selectToolLaunch: toolRuntime.selectToolLaunch, toolObservationFor: toolRuntime.toolObservationFor, toolRuntimeRoot: toolRuntime.toolRuntimeRoot, toolInspector: toolRuntime.hostInspector, toolLaunchForHost: agent => toolRuntime.manager.currentSelection(agent, "web"), copilotRequired, paths, owner: { serverOrigin: serverUrl, ownerUserId: userId, workerId }, serverToken, emit,
      canAdmitNewExecution: () => { const current = manager.current(); return manager.isReady() && current.effective.agentControlMode === "web" && current.selectedProjects !== null && current.effective.native !== null && current.effective.recoveryLimit !== null; },
      configuration: () => {
        const effective = manager.current().effective;
        // Assistant capability collection owns per-Provider Web argument failures.
        // Keep unavailable native defaults from failing the whole Worker report.
        return effective.native === null || effective.recoveryLimit === null ? null : {
          ...normalizeWorkerNative(effective.native, local, false).native,
          agentControlMode: "web", recoveryLimit: effective.recoveryLimit,
          ...(local.agentModel !== undefined || local.agentReasoningEffort !== undefined ? { validateNativeSelection: true as const } : {}),
        };
      },
      pollIntervalMs: () => manager.current().effective.pollIntervalMs,
      recoveryLimit: () => manager.current().effective.recoveryLimit,
    });
    botRun = bots.run(signal).catch(executionFailure);
    configurationBootstrap = createWorkerConfigurationBootstrap({ paths, identity: { serverOrigin: serverUrl, userId, workerId }, signal, resolveProject });
    const exchange = createWorkerConfigurationExchange({ manager, needsRead: resource === undefined, bootstrap: configurationBootstrap, prompts: currentPromptSource,
      onStage: configurationDiagnostics.exchange,
      read: operation => readCloudConfiguration(operation.signal, operation),
      send: async (report, captured, operation, selectors) => {
        const receipt = await remote.reportConfiguration(workerId, report, captured, operation, selectors);
        // Recovery needs the service's accepted machine identity, independently
        // of whether local configuration receipt persistence can finish.
        if (report.machine.id === machine.id && report.machine.name === machine.name) bots!.confirmMachineReport();
        return receipt;
      },
    });
    const telemetry = createWorkerTelemetryCollector({ paths, homeDirectory: options.homeDirectory, version: options.version, workingDirectory: options.workingDirectory, machine, platform, workerId, serverOrigin: serverUrl, assistantHost: bots, toolPaths: { context: () => "web", snapshot: () => toolRuntime.manager.snapshot() } });
    let cachedTelemetry: Awaited<ReturnType<typeof telemetry.collect>> | undefined;
    reporter = createWorkerReporter({ signal: managementSignal, executionActive: () => !signal.aborted, collect: async operation => {
      if (signal.aborted) {
        if (cachedTelemetry === undefined) throw new Error("Execution telemetry is unavailable while the scope is stopped.");
        return cachedTelemetry;
      }
      const executionOperation = createOperation({ signal: AbortSignal.any([operation.signal, signal]), limits: operation.limits });
      let sample: Awaited<ReturnType<typeof telemetry.collect>>;
      try { sample = await telemetry.collect(executionOperation); }
      finally { executionOperation.dispose(); }
      const snapshot = manager.current();
      const runtimeConfiguration = workerRuntimeConfigurationReport(snapshot.effective, local, "cloud");
      cachedTelemetry = { ...sample, telemetry: { ...sample.telemetry, ...(runtimeConfiguration === undefined ? {} : { runtimeConfiguration }) } };
      return cachedTelemetry;
    }, send: async (report, operation) => {
      const receipt = await remote.report(workerId, report, operation);
      if (report.machine.id === machine.id && report.machine.name === machine.name) bots!.confirmMachineReport();
      return receipt;
    }, emit, configuration: exchange });
    root.executionReporterActive = true;
    reviewerRun = runReviewerHost({ homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, serverOrigin: serverUrl,
      serverToken, userId, workerId, signal, emit }).finally(() => { reviewerSettled = true; });
    void reviewerRun.catch(executionFailure);
    scheduleInitialRemovals = () => { if (!signal.aborted) void ensureInitialRemovals().catch(error => { if (!signal.aborted) emit({ kind: "reconciliation-error", message: "Retained project removal reconciliation failed; configuration reporting remains active.", error }); }); };
    scheduleInitialRemovals();
    signal.throwIfAborted();
    let coordinatorJob: Promise<ReturnType<typeof createWorkerCoordinator>> | undefined;
    const ensureCoordinator = (): Promise<ReturnType<typeof createWorkerCoordinator>> => {
      if (coordinator !== undefined) return Promise.resolve(coordinator);
      if (coordinatorJob !== undefined) return coordinatorJob;
      const job = (async () => {
        const currentStore = getStore();
        if (web === undefined) web = await createWebRuntime(options, paths, currentStore, getGit(), serverUrl, serverToken, workerId, userId, platform, emit, signal, currentPromptSource, undefined, observer, toolRuntime, () => manager.current().effective.archiveSessions);
        if (renewal === undefined) renewal = maintainWorkerControllerGrants({ homeDirectory: options.homeDirectory, serverOrigin: serverUrl, store: web.webStore, launcher: web.launcher, signal,
          onError: message => emit({ kind: "credential-renewal-error", message }),
        }).catch(executionFailure);
        signal.throwIfAborted();
        const current = view(manager.current()) ?? { repositories: [], targetProjectIds: manager.current().selectedProjects?.map(project => project.projectId) ?? getStore().listProjects().map(project => project.projectId), readyProjectIds: [], globalConfiguration: null, maxConcurrent: 1, preferPlatformSpecificTasks: false };
        coordinator = createWorkerCoordinator({ freezeConfiguration: toolRuntime.freezeConfiguration, cleanupCommandLifecycle,
          retiredNativeCleanup: createRetiredClaimNativeCleanup({ homeDirectory: options.homeDirectory, identity: { serverOrigin: serverUrl, userId, workerId }, jobLeases: web.jobLeases, ...(root.lifecycle === undefined ? {} : { lifecycle: root.lifecycle }) }),
          store: currentStore, git: getGit(), ...web, remote, serverOrigin: serverUrl, workerId, userId, platform, machine, ...current,
          archiveSessions: () => manager.current().effective.archiveSessions,
          prepareProject: async (projectId, preparationSignal) => {
            const project = currentStore.getProject({ projectId });
            if (project === null) throw new Error("The retained project binding is unavailable.");
            // Missing retained repositories are not new clones.
            await lstat(project.localPath);
            const operation = createOperation({ signal: preparationSignal });
            try { await getGit().prepareRepository(project, operation); } finally { operation.dispose(); }
          },
          monitoring: observer,
          onInventory: inventory => {
            const selectedProjects = manager.current().selectedProjects;
            const complete = unobservedLocalMappings.size === 0 && selectedProjects !== null && selectedProjects.every(project => currentStore.getProject({ projectId: project.projectId }) !== null);
            reporter!.publishInventory(complete ? inventory : null);
          },
          configurationComplete: () => {
            const current = manager.current();
            return manager.isReady() && current.effective.agentControlMode === "web" && current.selectedProjects !== null && unobservedLocalMappings.size === 0;
          },
          onClaim: reporter!.recordClaim,
          onConfigurationStale: () => { exchange.markNeedsRead(); reporter!.trigger(); },
          requestReconcile: reconcileWake.request,
          onPromptDemand: projectIds => { if (currentPromptSource.setDemand(projectIds)) reporter!.demandChanged(); },
          emit, signal });
        const latest = view(manager.current());
        if (latest !== null) coordinator.updateConfiguration(latest);
        return coordinator;
      })();
      coordinatorJob = job;
      void job.finally(() => { if (coordinatorJob === job) coordinatorJob = undefined; }).catch(() => undefined);
      return job;
    };
    await manager.configureProjectAdapters({ prepare: async (projectId, applicationSignal) => {
      const revision = manager.current().items.find(item => item.key.kind === "projectPreparation" && item.key.projectId === projectId)?.targetRevision;
      const previous = preparationFailures.get(projectId);
      if (previous !== undefined) { previous.successRevision = null; observeMonitoring(m => { m.updateFailureRetry(previous.operationId, "running"); m.setProjectPreparationReason(projectId, { observedAt: previous.observedAt, nextAttemptAt: null }); }); }
      let activityId: string | undefined;
      observeMonitoring(m => { activityId = m.startActivity({ kind: "maintenance", phase: "project-preparation", scope: { kind: "project", projectId } }); });
      try {
        const binding = await resolveBinding(projectId, applicationSignal);
        await reserveRepository(binding, applicationSignal);
        try {
          const operation = createOperation({ signal: applicationSignal });
          try { await getGit().prepareRepository(binding, operation); }
          finally { operation.dispose(); }
          applicationSignal.throwIfAborted();
          prepared.set(projectId, await admitRepository(binding, applicationSignal));
          const selectedProjects = manager.current().selectedProjects;
          if (selectedProjects !== null && !selectedProjects.some(project => project.projectId === projectId)) await manager.ensureProjectRemoval(projectId, applicationSignal);
        } finally { reservations.delete(projectId); }
        const failure = preparationFailures.get(projectId);
        if (failure !== undefined && revision !== undefined && !applicationSignal.aborted) failure.successRevision = revision;
        if (activityId !== undefined && !applicationSignal.aborted) observeMonitoring(m => m.updateActivity(activityId!, { progress: true }));
      } catch (error) {
        const reported = applicationSignal.aborted ? error : configurationPreparationFailure(error);
        const current = manager.current();
        const item = current.items.find(value => value.key.kind === "projectPreparation" && value.key.projectId === projectId);
        if (applicationSignal.aborted) {
          const failure = preparationFailures.get(projectId);
          if (failure !== undefined) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setProjectPreparationReason(projectId, { observedAt: failure.observedAt, nextAttemptAt: null }); });
        }
        if (!applicationSignal.aborted && revision !== undefined && item?.targetRevision === revision && current.selectedProjects?.some(project => project.projectId === projectId)) {
          const observedAt = new Date().toISOString(), operationId = preparationFailures.get(projectId)?.operationId ?? randomUUID();
          preparationFailures.set(projectId, { operationId, observedAt, revision, successRevision: null });
          observeMonitoring(m => {
            m.fail({ operationId, component: "project", phase: "project-preparation", scope: { kind: "project", projectId }, error: reported });
            m.setProjectPreparationReason(projectId, { observedAt, nextAttemptAt: null });
          });
        }
        throw reported;
      } finally {
        if (applicationSignal.aborted) {
          const failure = preparationFailures.get(projectId);
          if (failure !== undefined) { failure.successRevision = null; observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setProjectPreparationReason(projectId, { observedAt: failure.observedAt, nextAttemptAt: null }); }); }
        }
        if (activityId !== undefined) observeMonitoring(m => m.endActivity(activityId!));
      }
    }, remove: async (projectId, applicationSignal) => {
      const runningCoordinator = await ensureCoordinator();
      applicationSignal.throwIfAborted();
      const latest = view(manager.current());
      if (latest !== null) runningCoordinator.updateConfiguration(latest);
      await runningCoordinator.stopProject(projectId, applicationSignal);
      prepared.delete(projectId);
    } });
    let started = false, archiveDeferred = false;
    const archiveShouldYield = (): boolean => {
      const yielding = coordinator?.archiveYield() ?? true;
      if (yielding && !archiveDeferred) emit({ kind: "session-archive-deferred", message: "Completed session archive backfill is deferred while cleanup is pending or worker capacity is full." });
      archiveDeferred = yielding;
      return yielding;
    };
    signal.throwIfAborted();
    observeMonitoring(m => m.setLifecycle("running"));
    return async () => {
      while (!signal.aborted) {
        const revision = reconcileWake.snapshot();
        void Promise.resolve().then(() => toolRuntime.prepareWebCandidates(signal, copilotRequired())).then(changed => changed && !signal.aborted ? refreshToolProofs() : undefined).catch(error => { if (!signal.aborted) emit({ kind: "warning", message: "Worker tool selection observation could not be published.", error }); });
        try {
          const refreshedProofs = refreshToolProofs(); if (refreshedProofs !== undefined) await refreshedProofs;
          observeMonitoring(m => m.setPhase("configuration"));
          scheduleLocalMappingChecks();
          await ensureInitialRemovals();
          const current = view(manager.current());
          if (current !== null) {
            {
              await ensureCoordinator();
              if (coordinator !== undefined) {
                const latest = view(manager.current());
                if (latest !== null) { coordinator.updateConfiguration(latest); await coordinator.tick(); }
                if (!archiveShouldYield()) web!.archiveMaintenance.request(archiveShouldYield);
              }
            }
          } else observeMonitoring(m => { m.setAdmission("partial", [{ code: "configuration-incomplete", scope: { kind: "worker" }, observedAt: new Date().toISOString(), nextAttemptAt: null }]); m.staleCapacity(); });
          if (!started) { emit({ kind: "started", message: `Foreground worker ${workerId} on ${platform}; cloud-managed configuration; logs=${currentDiagnostics.filename}.` }); started = true; }
        } catch (error) {
          if (isWorkerCancellation(error, signal)) break;
          if (signal.aborted) throw error;
          observeMonitoring(m => { m.setAdmission("unknown", []); m.staleCapacity(); });
          emit({ kind: "reconciliation-error", message: "The reconciliation round failed; configuration reporting remains active and resources remain for the next successful observation.", error });
        }
        await currentDiagnostics.flush();
        if (signal.aborted) break;
        const interval = manager.current().effective.pollIntervalMs;
        observeMonitoring(m => { m.setPhase("waiting-poll"); m.setNextPoll(new Date(Date.now() + (interval ?? 1_000)).toISOString()); });
        try { await reconcileWake.waitAfter(revision, interval ?? 1_000, signal); }
        catch (error) { if (!isWorkerCancellation(error, signal)) throw error; }
        observeMonitoring(m => m.setNextPoll(null));
      }
    };
  };
  try {
    // Publish control before the first I/O. Aborting its waiter does not erase
    // the constructor Promise or permit owners to close before late resources join.
    startupWork = Promise.resolve().then(initialize).catch(error => {
      // A cancelled foreground waiter cannot report a late constructor failure.
      // Retain it independently without turning a completed join into a live owner.
      if (!isWorkerCancellation(error, signal) && !failures.includes(error)) failures.push(error);
      throw error;
    }).finally(() => { startupSettled = true; });
    publishControl();
    const run = await waitForConfigurationOperation(startupWork, signal);
    await run();
  } catch (error) {
    if (!isWorkerCancellation(error, signal) && !failures.includes(error)) failures.push(error);
  } finally {
    observeMonitoring(m => { m.setLifecycle("stopping"); m.setPhase("stopping"); });
    monitoringSender?.trigger();
    scope.closeAdmission(new Error("Worker execution scope is closing."));
    try { diagnostics?.emit({ kind: "shutdown", message: "Stopping agents while retaining unfinished claims, worktrees and native session IDs." }); }
    catch (error) { failures.push(error); }
    ownerResults = await scope.stop();
    publishControl();
    if (!managementSignal.aborted && options.onExecutionScope !== undefined) {
      // Management reporting consumes cached observations only while execution is closed.
      let abortWait: (() => void) | undefined;
      const aborted = new Promise<void>(resolve => { abortWait = resolve; managementSignal.addEventListener("abort", abortWait, { once: true }); });
      try { if (!rebuildRequested && !managementSignal.aborted) await Promise.race([rebuilding, aborted]); }
      finally { managementSignal.removeEventListener("abort", abortWait!); }
    }
    const finishManagement = async (): Promise<void> => {
      await joinStartup();
      await stopReporter();
      if (reportFailure !== undefined) {
        try {
          if (!hasOwnedCommandCleanupFailure(reportFailure)) throw reportFailure;
          // The original stop has joined the reporting loop. Re-observe its
          // retained failures after native owners reconcile their receipts;
          // stop never restarts collection or replaces a pending writer.
          await reporter?.stop();
          failures.push(reportFailure);
        } catch (error) { managementFailures.push(error); }
      }
      observeMonitoring(m => { if (scope.snapshot().stopped) { m.clearActivities(); m.setLifecycle("stopped"); m.setPhase("stopped"); } });
      try { await monitoringSender?.finish(); } catch { /* Monitoring delivery does not change shutdown. */ }
      try { await diagnostics?.close(); }
      catch (error) {
        // Historical output errors survive a joined close. Only the original
        // sink can confirm that its writes and stderr listeners are released.
        const destination = diagnostics?.isClosed?.() === true ? failures : managementFailures;
        if (!destination.includes(error)) destination.push(error);
      }
      failures.push(...configurationDiagnostics?.errors() ?? []);
      root.managementClosed = managementFailures.length === 0;
      delete root.readRecoverySources;
    };
    root.managementClosed = false;
    root.managementClosing = finishManagement();
    try { await withinExecutionDeadline(root.managementClosing, Date.now() + 10_000); } catch (error) { failures.push(error); }
  }
  const currentFailures = [...failures, ...ownerResults.flatMap(result => result.error === undefined ? [] : [result.error])];
  if (rebuildRequested && !managementSignal.aborted && scope.snapshot().stopped && root.managementClosed) {
    // A confirmed stop permits the requested new generation. Preserve earlier
    // execution errors for ordinary exit without treating them as live owners.
    root.previousScopeFailures.push(...currentFailures);
    return true;
  }
  throwFailures([...root.previousScopeFailures, ...currentFailures, ...managementFailures]);
  return false;
};

export const runWorkerControl = async (options: {
  homeDirectory: string; packageDirectory: string; version: string; request: WorkerControlRequest;
  log?: (message: string) => void; signal?: AbortSignal;
}): Promise<void> => {
  const platform = currentWorkerPlatform();
  const paths = resolveWorkerPaths(options.homeDirectory);
  const cancellation = runtimeCancellation(options.signal);
  const signal = cancellation.controller.signal;
  let lock: Awaited<ReturnType<typeof tryAcquireWorkerInstanceLock>> | undefined;
  let store: ReturnType<typeof openWorkerStore> | undefined;
  let web: Awaited<ReturnType<typeof createWebRuntime>> | undefined;
  let tools: ReturnType<typeof createWorkerToolSelectionRuntime> | undefined;
  let git: ReturnType<typeof createWorkerGitManager> | undefined;
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnostics>> | undefined;
  let configurationDiagnostics: ReturnType<typeof createWorkerConfigurationDiagnostics> | undefined;
  const configurationExchanges: ReturnType<typeof createWorkerConfigurationExchange>[] = [];
  let controlLifecycle: LifecycleStore | undefined;
  let controlLifecycleManager: LifecycleManager | undefined;
  let configurationManager: WorkerConfigurationManager | undefined;
  let configurationInitialization: Promise<WorkerConfigurationManager> | undefined;
  let controlPromptSource: ReturnType<typeof createWorkerPromptSource> | undefined;
  let controlBootstrap: ReturnType<typeof createWorkerConfigurationBootstrap> | undefined;
  let controlResource: ReceivedWorkerConfigurationResource | undefined;
  const failures: unknown[] = [];
  try {
    signal.throwIfAborted();
    lock = await tryAcquireWorkerInstanceLock(paths);
    if (lock === null) throw new Error("Stop daynight worker run before running a worker management command.");
    const local = await readWorkerLocalConfiguration(paths, signal);
    const { serverUrl, serverToken } = local;
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    const workerId = await ensureWorkerIdentity(paths, signal);
    store = openWorkerStore(paths.databaseFile);
    const remote = createWorkerRemote({ serverUrl, serverToken });
    const userId = await remote.currentUserId(signal);
    const runControl = async (store: ReturnType<typeof openWorkerStore>): Promise<void> => {
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    configurationDiagnostics = createWorkerConfigurationDiagnostics({ emit: diagnostics.emit });
    await mkdir(paths.temporaryDirectory, { recursive: true, mode: 0o700 });
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory, reportPending: gitPendingReporter(diagnostics.emit), reportSettled: gitSettledReporter(diagnostics.emit), reportHolderTerminated: holderTerminatedReporter(diagnostics.emit),
      prepareFormat: (project, repository, operation) => prepareWorkerWorktreeFormat({ paths, store: store!, project, repository, operation, workerId, serverOrigin: serverUrl, verifyWebUnregistered: createWorkerSessionApi(serverUrl, serverToken).verifyUnregistered }),
    });
    const nativeApplication = nativeConfigurationApplication({ tools: () => tools, paths, homeDirectory: options.homeDirectory, workingDirectory: options.homeDirectory, overrides: local, signal, emit: diagnostics.emit });
    const toolEnvironment = { agentEnvironment: { DN_CONFIG_DIR: paths.stateDirectory } };
    tools = createWorkerToolSelectionRuntime({ workerDirectory: paths.workerDirectory, cwd: options.homeDirectory, environment: { ...process.env, ...toolEnvironment.agentEnvironment }, localToolPaths: local.toolPaths,
      readActiveSelections: () => [...webToolSelections(options.homeDirectory, web)] });
    const toolRuntime = tools;
    const initializeConfiguration = (): Promise<WorkerConfigurationManager> => configurationInitialization ??= createWorkerConfigurationManager({
      file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal, localToolPaths: local.toolPaths,
      ...toolRuntime.configurationOptions, onChange: snapshot => { toolRuntime.setTargets(snapshot.toolTargets); }, applyNative: nativeApplication.apply,
      onApplication: configurationDiagnostics!.application,
      onStorageState: configurationDiagnostics!.storage,
    }).then(manager => { configurationManager = manager; return manager; });
    let coordinatorConfiguration: WorkerCoordinatorConfiguration = { repositories: [], globalConfiguration: null, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    const sources = store.listTasks().filter(task => task.taskId === options.request.taskId && task.claimId === options.request.claimId && (options.request.projectId === undefined || task.projectId === options.request.projectId));
    if (sources.length > 1) throw new Error("The source claim is ambiguous; supply --project.");
    if (sources.length === 0 || sources[0]!.status === "done") throw new Error("Management requires the original unfinished local execution.");
    const targetProjectId = sources[0]!.projectId;
    const frozenRetry = options.request.kind === "retry";
    if (options.request.kind !== "release" && !frozenRetry) {
      let resource: ReceivedWorkerConfigurationResource;
      const syncId = randomUUID();
      configurationDiagnostics.exchange({ syncId, phase: "authority-read", status: "started", source: null, remoteOutcome: "not_sent", localOutcome: "not_attempted" });
      try { resource = await remote.configuration(workerId, signal); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) {
          const requestId = workerConfigurationRequestId(error);
          configurationDiagnostics.exchange({ syncId, phase: "authority-read", status: "failed", source: null, remoteOutcome: failedConfigurationRequestOutcome(error), localOutcome: "not_attempted", ...(requestId === undefined ? {} : { requestId }), error });
          throw error;
        }
        resource = { json: '{"desired":null,"observationRevision":"0","observation":null}', desired: null, observationRevision: "0", observationJson: null };
      }
      configurationDiagnostics.exchange({ syncId, phase: "authority-read", status: "succeeded", source: null, remoteOutcome: "success", localOutcome: resource.desired === null ? "not_attempted" : "pending", received: { desiredRevision: resource.desired?.revision ?? null, observationRevision: resource.observationRevision } });
      controlResource = resource;
      if (resource.desired === null) {
        const initial = await validateWorkerConfigurationSource(local.source === undefined ? "{}" : local.source, paths, signal);
        const repositories: WorkerRepositoryAssignment[] = [];
        for (const repository of initial.repositories) {
          if (targetProjectId !== undefined && repository.projectId !== undefined && repository.projectId !== targetProjectId) continue;
          try {
            const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, signal);
            if (targetProjectId !== undefined && project.id !== targetProjectId) continue;
            const binding = await createWorkerRepositoryAdmission({ paths, store: () => store!, workerId, serverOrigin: serverUrl }).admit({ projectId: project.id, repoUrl: repository.remote, localPath: repository.path }, signal);
            repositories.push({ project: binding, configuration: repository });
          } catch (error) {
            if (signal.aborted || repository.projectId === targetProjectId || targetProjectId === undefined || error instanceof ProtocolError || error instanceof ApiError && !projectUnavailable(error)) throw error;
            diagnostics.emit({ kind: "warning", message: "An unrelated worker repository could not be resolved for management.", error });
          }
        }
        coordinatorConfiguration = { repositories, globalConfiguration: initial, maxConcurrent: initial.maxConcurrent, preferPlatformSpecificTasks: initial.preferPlatformSpecificTasks };
      } else {
        configurationManager = await initializeConfiguration();
        const previous = configurationManager.current();
        await configurationManager.receive(resource.desired, resource.observationRevision, signal, syncId, resource.observationJson === null ? null : { observationRevision: resource.observationRevision, json: resource.observationJson });
        const current = configurationManager.current();
        configurationDiagnostics.exchange({ syncId, phase: "authority-read", status: "succeeded", remoteOutcome: "success", localOutcome: "persisted",
          source: { state: "initialized", generation: current.generation, desiredRevision: current.desiredRevision, observationRevision: current.observationRevision },
          previousSource: { state: "unread", generation: previous.generation, desiredRevision: previous.desiredRevision, observationRevision: previous.observationRevision },
          received: { desiredRevision: resource.desired.revision, observationRevision: resource.observationRevision } });
        await configurationManager.settle(signal);
        const effective = configurationManager.current().effective;
        if (effective.maxConcurrent === null || effective.recoveryLimit === null || effective.preferPlatformSpecificTasks === null) throw new Error("The Worker's cloud runtime parameters are unavailable.");
        const globalConfiguration = effective.native === null ? null : effectiveExecutionConfiguration(effective.native, effective.recoveryLimit, local);
        const repositories = store.listProjects().flatMap(project => {
          const selected = effective.projects.find(value => value.projectId === project.projectId);
          const native = selected === undefined ? effective.native : selected.native;
          return native === null ? [] : [{ project, configuration: effectiveExecutionConfiguration(native, effective.recoveryLimit!, local) }];
        });
        coordinatorConfiguration = { repositories, readyProjectIds: store.listProjects().map(project => project.projectId), globalConfiguration, maxConcurrent: effective.maxConcurrent, recoveryLimit: effective.recoveryLimit, preferPlatformSpecificTasks: effective.preferPlatformSpecificTasks,
          ...(effective.taskTagFilterKey === undefined ? {} : { taskTagFilterKey: effective.taskTagFilterKey }) };
      }
    }
    if (options.request.kind === "release" || frozenRetry) await initializeConfiguration();
    const controlArchiveSessions = (): boolean | null => {
      const current = configurationManager?.current();
      return current?.effective.archiveSessions ?? current?.retainedArchiveSessions ?? null;
    };
    const machine = machineDescription(platform);
    const retryPromptSource = options.request.kind === "retry" ? createWorkerPromptSource({ serverOrigin: serverUrl, userId, workerId }) : undefined;
    controlPromptSource = retryPromptSource;
    let attemptedPromptSync = false;
    const preparePromptSource = retryPromptSource === undefined ? undefined : async (projectId: string, inputSignal?: AbortSignal): Promise<void> => {
      if (attemptedPromptSync) return;
      attemptedPromptSync = true;
      retryPromptSource.setDemand([projectId]);
      retryPromptSource.beginCycle();
      const operation = createOperation({ signal: inputSignal === undefined ? signal : AbortSignal.any([signal, inputSignal]), limits: { totalMs: 15_000, requestMs: 10_000 } });
      try {
        const manager = await waitForConfigurationOperation(initializeConfiguration(), operation.signal);
        if (controlResource !== undefined && !manager.current().synchronized) await manager.receive(controlResource.desired, controlResource.observationRevision, operation.signal, undefined, controlResource.observationJson === null ? null : { observationRevision: controlResource.observationRevision, json: controlResource.observationJson });
        controlBootstrap ??= createWorkerConfigurationBootstrap({ paths, identity: { serverOrigin: serverUrl, userId, workerId }, signal, resolveProject: remote.resolveProject });
        const exchange = createWorkerConfigurationExchange({ manager, needsRead: controlResource === undefined, bootstrap: controlBootstrap, prompts: retryPromptSource,
          onStage: configurationDiagnostics!.exchange,
          read: async current => {
            try { return await remote.configuration(workerId, current.signal, current); }
            catch (error) {
              if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) throw error;
              return { json: '{"desired":null,"observationRevision":"0","observation":null}', desired: null, observationRevision: "0", observationJson: null };
            }
          },
          send: (report, captured, current, selectors) => remote.reportConfiguration(workerId, report, captured, current, selectors),
        });
        configurationExchanges.push(exchange);
        const telemetry = createWorkerTelemetryCollector({ paths, homeDirectory: options.homeDirectory, version: options.version, workingDirectory: options.homeDirectory, machine, platform, workerId, serverOrigin: serverUrl, toolPaths: { context: () => "web", snapshot: () => toolRuntime.manager.snapshot() } });
        const outcome = await syncWorkerConfigurationOnce({ operation, configuration: exchange, report: async () => {
          const sample = await telemetry.collect(operation);
          const cleanupFailure = sample.issues.find(issue => hasUnconfirmedOwnedCommandCleanup(issue.error));
          if (cleanupFailure !== undefined) throw cleanupFailure.error;
          return { ...sample.telemetry, taskInventory: null };
        } });
        if (outcome.promptError || retryPromptSource.current(projectId) === null) diagnostics!.emit({ kind: "warning", message: "Worker prompt synchronization is unavailable; new input remains waiting." });
      } catch (error) {
        if (signal.aborted || inputSignal?.aborted || hasUnconfirmedOwnedCommandCleanup(error)) throw error;
        diagnostics!.emit({ kind: "warning", message: "Worker prompt synchronization failed; new input remains waiting." });
      } finally { operation.dispose(); }
    };
    web = await createWebRuntime(options, paths, store, git, serverUrl, serverToken, workerId, userId, platform, diagnostics.emit, signal, retryPromptSource, preparePromptSource, undefined, toolRuntime, controlArchiveSessions);
    if (frozenRetry) {
      const original = sources[0]!, saved = store.getNativeConfiguration(original);
      const frozen = web.webStore.getTask(original)?.configuration ?? (saved === null ? null : { ...saved, agentControlMode: "web", recoveryLimit: workerConfigurationDefaults.recoveryLimit });
      coordinatorConfiguration = { repositories: [], globalConfiguration: frozen, recoveryLimit: frozen?.recoveryLimit ?? workerConfigurationDefaults.recoveryLimit, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    }
    const taskTagFilterKey = configurationManager?.current().effective.taskTagFilterKey;
    const coordinator = createWorkerCoordinator({
      freezeConfiguration: toolRuntime.freezeConfiguration, store, git, ...web, remote, serverOrigin: serverUrl, workerId, userId, platform, machine, ...coordinatorConfiguration,
      retiredNativeCleanup: createRetiredClaimNativeCleanup({ homeDirectory: options.homeDirectory, identity: { serverOrigin: serverUrl, userId, workerId }, jobLeases: web.jobLeases, ...(controlLifecycle === undefined ? {} : { lifecycle: controlLifecycle }) }),
      ...(taskTagFilterKey === undefined ? {} : { taskTagFilterKey }),
      archiveSessions: controlArchiveSessions,
      emit: diagnostics.emit, signal,
    });
    const prepareControlProject = async (identity: { projectId: string }): Promise<void> => {
      const project = store!.getProject(identity);
      if (project === null) throw new Error("The original project repository binding is unavailable.");
      // Management never recreates a missing retained repository.
      await lstat(project.localPath);
      const operation = createOperation({ signal });
      try { await git!.prepareRepository(project, operation); } finally { operation.dispose(); }
    };
    const controlCoordinator = {
      ...coordinator,
      advanceRetry: async (identity: Parameters<typeof coordinator.advanceRetry>[0]) => {
        const project = store!.getProject(identity);
        if (project === null) throw new Error("The original project repository binding is unavailable.");
        await lstat(project.localPath);
        return coordinator.advanceRetry(identity, () => prepareControlProject(identity));
      },
      cleanupSource: async (identity: Parameters<typeof coordinator.cleanupSource>[0], settings: Parameters<typeof coordinator.cleanupSource>[1]) => {
        if (settings?.deleteWorktree === true) await prepareControlProject(identity);
        return coordinator.cleanupSource(identity, settings);
      },
      completeSource: async (owner: Parameters<typeof coordinator.completeSource>[0], ownerUserId: Parameters<typeof coordinator.completeSource>[1]) => {
        await prepareControlProject(owner);
        return coordinator.completeSource(owner, ownerUserId);
      },
    };
    const result = await submitWorkerControl({
      store, remote, serverOrigin: serverUrl, workerId,
      request: options.request, signal, coordinator: controlCoordinator,
    });
    diagnostics.emit({ kind: "management", ...(result.task === null ? {} : { task: result.task }), message: result.message });
    };
    const lifecycleFile = path.join(paths.workerDirectory, "lifecycle.sqlite");
    if (options.request.kind === "retry" && (store.lifecycleAdopted() || existsSync(lifecycleFile))) {
      const lifecycle = controlLifecycle = openLifecycleStore({ file: lifecycleFile, identity: { serverOrigin: serverUrl, userId, workerId }, allowCreate: false });
      try {
        const journal = await openExecutionResourceJournal({ directory: path.join(paths.workerDirectory, "execution-resources"), identity: { serverOrigin: serverUrl, userId, workerId } });
        const root: WorkerManagementRoot = { cancellation, lock, store, identity: { serverOrigin: serverUrl, userId, workerId }, lifecycle, journal, managementClosed: true, previousScopeFailures: [] };
        const manager = controlLifecycleManager = createLifecycleManager({ store: lifecycle,
          api: createWorkerLifecycleClient({ serverUrl, serverToken, userId, workerId }), platform, signal,
          reconcileResources: deadline => reconcileLifecycleResources({ ...options, workingDirectory: options.homeDirectory }, root, deadline),
          reportError: error => options.log?.(`Worker retry lifecycle: ${String(error)}\n`) });
        const binding = await manager.initializeForControl();
        const stopControl = async (): Promise<OwnerStopResult[]> => {
          cancellation.controller.abort(new Error("Worker retry admission closed."));
          // The control command's finally block owns the eventual join and save;
          // waking it is not itself a stop receipt.
          return [{ resourceId: "retry", ownerKind: "task", generation: binding.scopeGeneration, stop: "unknown", save: "failed" }];
        };
        manager.attach({ stop: stopControl, reconcile: stopControl, rebuild: () => { throw new Error("An independent retry cannot rebuild a foreground Worker scope."); } });
        manager.start();
        const reserved = new Set<string>();
        await withWorkerLifecycle({ store: lifecycle, binding, failed: error => { cancellation.controller.abort(error); lifecycle.markBlocked("persistence_failed"); } }, () => withOwnedCommandLifecycle(async event => {
          if (event.stage === "prepared" && !reserved.has(event.resourceId)) {
            lifecycle.reserveExecution({ binding, resourceId: event.resourceId, ownerKind: "repository", identity: { kind: "owned_command" }, operationId: event.resourceId }); reserved.add(event.resourceId);
          }
          await journal.sink(binding.scopeGeneration)(event);
          if (event.stage === "bound") lifecycle.recordResource({ resourceId: event.resourceId, stage: "running", processProof: JSON.parse(JSON.stringify(event.proof)) as LifecycleJson });
          if (event.stage === "stopped") lifecycle.recordResource({ resourceId: event.resourceId, stage: "stopped", stopProof: { kind: "owned_boundary", sequence: event.sequence }, saveState: "durable" });
          if (event.stage === "unknown") lifecycle.recordResource({ resourceId: event.resourceId, stage: "unknown", error: "Retry command boundary remains unconfirmed." });
        }, () => runControl(store!)));
      } finally { lifecycle.closeForRestart(); }
    } else await runControl(store);
  } catch (error) { failures.push(error); }
  finally {
    if (!signal.aborted) cancellation.controller.abort(new Error("Worker management is closing."));
    try { await controlLifecycleManager?.close(); } catch (error) { failures.push(error); }
    configurationManager?.beginDrain();
    const bootstrapStopped = controlBootstrap?.stop().catch(error => { failures.push(error); });
    controlPromptSource?.close();
    await bootstrapStopped;
    try { await configurationInitialization; } catch (error) { if (!isWorkerCancellation(error, signal) && !failures.includes(error)) failures.push(error); }
    try { await configurationManager?.stop(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
    try { await web?.archiveMaintenance.close(); } catch (error) { failures.push(error); }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { web?.webBackend.closeInput(); web?.webStore.close(); } catch (error) { failures.push(error); }
    try { await tools?.close(); } catch (error) { failures.push(error); }
    try { controlLifecycle?.close(); } catch (error) { failures.push(error); }
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await diagnostics?.close(); } catch (error) { failures.push(error); }
    failures.push(...(configurationDiagnostics?.errors() ?? []));
    for (const exchange of configurationExchanges) failures.push(...workerConfigurationDiagnosticFailures(exchange));
    try { await lock?.release(); } catch (error) { failures.push(error); }
    cancellation.dispose();
  }
  throwFailures(failures);
};
