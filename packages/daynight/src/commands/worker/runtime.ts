import { createWebArchiveMaintenance } from "./web-archive-backfill.js";
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
import { createWorkerSessionApi } from "./backends/session-api.js";
import type { WorkerEvent } from "./execution.js";
import type { WorkerPaths } from "./paths.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { statfsSync } from "node:fs";
import type { WorkerResourceCommandRequest } from "./resource-disposal.js";
import { assertHerdrDisposalTarget, reconcileDeletedHerdrResource } from "./resource-disposal.js";
import { lstat, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { createReconcileWake } from "./reconcile-wake.js";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { repositoryLocation, resolveRepositoryRoot } from "../../repository/location.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { ApiError } from "../../api/client.js";
import { ProtocolError } from "../../api/parse.js";
import { parseWorkerCloudReport } from "../../api/worker-configuration.js";
import type { WorkerCloudNative, WorkerCloudResource, WorkerCloudValue } from "../../api/worker-configuration.js";
import { probeNativeAgentVersion } from "./herdr/version-probe.js";
import { createWorkerConfigurationManager, resolveWorkerCloudProjectNative } from "./configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationSnapshot } from "./configuration.js";
import { parseWorkerCloudBootstrap, readWorkerLocalConfiguration, resolveCloudNative, workerLocalExplicitProjectIds, workerLocalRepositoryForId, workerLocalRepositoryForProject, workerLocalUnboundRepository, workerLocalUnboundRepositoryIndexes } from "./configuration-source.js";
import type { WorkerProject } from "./types.js";
import type { AgentControlMode, TaskPlatform, WorkerMachine } from "../../api/types.js";
import { validateWorkerConfigurationSource, validateWorkerRepositoryLocations, workerConfigurationDefaults } from "./config.js";
import { createWorkerCoordinator } from "./coordinator.js";
import { createMonitoringObserver } from "./monitoring/observer.js";
import { createMonitoringSender } from "./monitoring/sender.js";
import type { WorkerCoordinatorConfiguration, WorkerRepositoryAssignment } from "./coordinator.js";
import { submitWorkerControl } from "./control.js";
import type { WorkerControlRequest } from "./control.js";
import { createWorkerDiagnostics, workerSqliteMigrationEvent } from "./diagnostics.js";
import { isWorkerCancellation } from "./execution.js";
import type { ExecutionConfiguration } from "./types.js";
import { createSharedWorkerHerdr } from "./herdr/shared.js";
import { hasUnconfirmedHerdrCommandCleanup } from "./herdr/command.js";
import type { WorkerHerdrAdapter } from "./herdr.js";
import { createDurableWorkerHerdr } from "./herdr/durable.js";
import { ensureWorkerIdentity } from "./identity.js";
import { acquireWorkerInstanceLock, tryAcquireWorkerInstanceLock } from "./instance-lock.js";
import { resolveWorkerPaths } from "./paths.js";
import { buildWorkerPrompt } from "./prompts.js";
import { createWorkerPromptSource } from "./prompt-source.js";
import { createWorkerRemote } from "./remote.js";
import { createWorkerReporter, syncWorkerConfigurationOnce } from "./reporter.js";
import { createWorkerRepositoryAdmission } from "./repository-admission.js";
import { createWorkerTelemetryCollector } from "./telemetry.js";
import { openWorkerStore } from "./store.js";
import { shutdownWorkerExecutions } from "./shutdown.js";
import { createWorkerBotHost, type WorkerBotHost } from "./bots/host.js";
import { createWorkerReadOnlyChannel } from "./read-only/channel.js";
import { browseWorkerDirectory } from "./read-only/directory.js";
import { createWorkerModelDiscovery, WorkerModelDiscoveryError, type WorkerModelInput } from "./read-only/models.js";
import type { WorkerReadOnlyOperations, WorkerReadOnlyOperation } from "./read-only/channel.js";
import type { WorkerDirectoryInput } from "./read-only/directory.js";
import { createWorkerGitManager, type WorkerGitPending } from "./worktrees.js";
import { normalizeWorkerNative, workerRuntimeConfigurationReport } from "./native-overrides.js";
import type { WorkerLocalNativeOverrides } from "./local-native.js";
import { createWorkerToolSelectionRuntime } from "./tool-selection-runtime.js";
import { readWebToolActivity } from "./tool-activity.js";
import type { ActiveToolSelection } from "./tool-selection.js";
import { createNativeSelectionVerifier } from "./native-selection.js";

const gitPendingReporter = (emit: (event: WorkerEvent) => void) => (pending: WorkerGitPending): void => {
  emit({ kind: "git-cleanup-pending", message: `Git ${pending.command} local cleanup remains pending; waiting for local close.`, projectId: pending.projectId,
    ...(pending.owner === undefined ? {} : { identity: pending.owner }), component: "git", phase: pending.command, attemptId: pending.attemptId, error: pending.error });
};
const gitSettledReporter = (emit: (event: WorkerEvent) => void): NonNullable<Parameters<typeof createWorkerGitManager>[0]["reportSettled"]> => (pending, settlement) => {
  emit({ kind: "git-local-closed", message: `Git ${pending.command} local resources closed.`, projectId: pending.projectId,
    ...(pending.owner === undefined ? {} : { identity: pending.owner }), component: "git", phase: pending.command, attemptId: pending.attemptId,
    ...(settlement.cleanupErrors.length === 0 ? {} : { error: new AggregateError(settlement.cleanupErrors, "Repository Git local cleanup reported errors.", { cause: pending.error }) }) });
};

const hasHerdrJournal = async (paths: WorkerPaths, platform: TaskPlatform): Promise<boolean> => {
  if (platform !== "macos") return false;
  try { await lstat(path.join(paths.workerDirectory, "herdr-executions.sqlite")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
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

const effectiveExecutionConfiguration = (native: WorkerCloudNative, mode: AgentControlMode, recoveryLimit: number, local: WorkerLocalNativeOverrides) => ({
  ...resolveCloudNative(normalizeWorkerNative(native, mode, local).native, mode, recoveryLimit),
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
    prepareEnvironment: getEnvironment,
    apply: async (native: WorkerCloudNative, signal: AbortSignal, mode: AgentControlMode): Promise<void> => {
      normalizeWorkerNative(native, mode, options.overrides);
      const nativeEnvironment = await getEnvironment();
      const tools = options.tools?.();
      if (tools !== undefined) {
        await tools.prepareNative(native, mode, signal);
        if (native.agent === "codex" || native.agent === "copilot") return;
      }
      const operation = createOperation({ signal, limits: { totalMs: 15_000, requestMs: 10_000 } });
      try { await probeNativeAgentVersion({ agent: native.agent, environment: { ...process.env, ...nativeEnvironment.agentEnvironment }, cwd: options.workingDirectory }, operation); }
      finally { operation.dispose(); }
    },
  };
};

const createWebRuntime = async (options: { homeDirectory: string; packageDirectory: string }, paths: WorkerPaths, store: ReturnType<typeof openWorkerStore>, git: ReturnType<typeof createWorkerGitManager>, serverUrl: string, serverToken: string, platform: TaskPlatform, emit: (event: WorkerEvent) => void, signal: AbortSignal, promptSource?: ReturnType<typeof createWorkerPromptSource>, preparePromptSource?: (projectId: string, signal: AbortSignal) => Promise<void>, monitoring?: ReturnType<typeof createMonitoringObserver>, tools?: ReturnType<typeof createWorkerToolSelectionRuntime>) => {
  const webStore = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite"), { onMigration: event => { emit(workerSqliteMigrationEvent(event)); } });
  try {
    const api = createWorkerSessionApi(serverUrl, serverToken);
    const launcher = createWebControllerLauncher({ ...options, ...(tools === undefined ? {} : { selectToolLaunch: tools.selectToolLaunch, toolObservationFor: tools.toolObservationFor }), store: webStore, sessionApi: api, now: Date.now });
    const archive: NonNullable<import("./backends/web.js").WebBackendOptions["archive"]> = async (task, journalPath, signal) => {
      if (!task.webExecution) throw new Error("Original controller execution is missing.");
      const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution.launchId);
      if (ticket.serverOrigin !== serverUrl || task.serverOrigin !== serverUrl) throw new Error("Archive server identity changed.");
      await uploadStoppedControllerArchive({ journalPath, ticket, serverToken, signal });
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
    const archiveMaintenance = createWebArchiveMaintenance({ homeDirectory: options.homeDirectory, serverUrl, signal, store, webStore, archive, probeArchive, emit, ...(monitoring === undefined ? {} : { monitoring }) });
    const webBackend = createWebExecutionBackend({ homeDirectory: options.homeDirectory, store: webStore, git, launcher, platform, now: Date.now, archive, probeArchive, ...(monitoring === undefined ? {} : { onUnattributed: (identity: { projectId: string; taskId: string; claimId: string }, operationKey: string, value: boolean) => monitoring.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operationKey}`, value) }), ...(promptSource === undefined ? {} : { promptSource }), ...(preparePromptSource === undefined ? {} : { preparePromptSource }),
      buildPrompt: (task, actualPlatform) => {
        if (task.configuration === null || task.resources.worktree === null) throw new Error("The frozen Web assignment is incomplete.");
        return buildWorkerPrompt({ ...task, agent: task.configuration.agent, agentControlMode: "web", sessionId: task.resources.nativeSession?.sessionId ?? null, configuration: task.configuration, worktree: task.resources.worktree }, actualPlatform);
      },
      emit: event => {
        const task = event.task === undefined ? null : store.getTask(event.task);
        emit({ kind: event.kind, message: event.message, ...(event.task === undefined ? {} : { identity: { projectId: event.task.projectId, taskId: event.task.taskId, claimId: event.task.claimId, worktreeId: event.task.worktreeId } }), ...(task === null ? {} : { task }), ...(event.component === undefined ? {} : { component: event.component }), ...(event.phase === undefined ? {} : { phase: event.phase }), ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }), ...(event.runKey === undefined ? {} : { runKey: event.runKey }), ...(event.error === undefined ? {} : { error: event.error }) });
      },
    });
    return { webStore, webBackend, launcher, archiveMaintenance, verifyWebServer: api.verifySupport, verifyWebUnregistered: api.verifyUnregistered, verifyWebStartupReporting: api.supportsStartupReports, buildPrompt: buildWorkerPrompt };
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

const retainedHerdrToolSelections = (store: ReturnType<typeof openWorkerStore> | undefined): ActiveToolSelection[] => store?.listUnfinishedTasks().flatMap(task => {
  if ((task.agentControlMode ?? "herdr") !== "herdr" || task.sessionId === null) return [];
  const frozen = store.getNativeConfiguration(task);
  const tools = task.agent === "codex" || task.agent === "copilot" ? [task.agent, "herdr"] as const : ["herdr"] as const;
  return tools.map(tool => {
    const launch = tool === "herdr" ? frozen?.herdrLaunch : frozen?.toolLaunch;
    const observation = tool === "herdr" ? frozen?.herdrObservation : frozen?.toolObservation;
    return { tool, context: "herdr", launch: launch ?? null, version: observation?.version ?? null, checkedAt: observation?.checkedAt ?? null, executionCount: null, instanceCount: null, unconfirmedCount: 1 };
  });
}) ?? [];

export const runWorker = async (options: {
  homeDirectory: string; packageDirectory: string; version: string; workingDirectory: string;
  log?: (message: string) => void; signal?: AbortSignal;
}): Promise<void> => {
  const platform = currentWorkerPlatform();
  const paths = resolveWorkerPaths(options.homeDirectory);
  const cancellation = runtimeCancellation(options.signal);
  const signal = cancellation.controller.signal;
  let lock: Awaited<ReturnType<typeof acquireWorkerInstanceLock>> | undefined;
  let store: ReturnType<typeof openWorkerStore> | undefined;
  let web: Awaited<ReturnType<typeof createWebRuntime>> | undefined;
  let tools: ReturnType<typeof createWorkerToolSelectionRuntime> | undefined;
  let git: ReturnType<typeof createWorkerGitManager> | undefined;
  let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
  let herdr: WorkerHerdrAdapter | undefined;
  let selectionHerdr: ReturnType<typeof createSharedWorkerHerdr> | undefined;
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnostics>> | undefined;
  let configuration: WorkerConfigurationManager | undefined;
  let renewal: Promise<void> | undefined;
  let reporter: ReturnType<typeof createWorkerReporter> | undefined;
  let promptSource: ReturnType<typeof createWorkerPromptSource> | undefined;
  let bots: WorkerBotHost | undefined;
  let botRun: Promise<void> | undefined;
  let readOnly: ReturnType<typeof createWorkerReadOnlyChannel> | undefined;
  let modelDiscovery: ReturnType<typeof createWorkerModelDiscovery> | undefined;
  let initialRemovalReconciliation: Promise<void> | undefined;
  let monitoring: ReturnType<typeof createMonitoringObserver> | undefined;
  let monitoringSender: ReturnType<typeof createMonitoringSender> | undefined;
  const observeMonitoring = (action: (observer: NonNullable<typeof monitoring>) => void): void => {
    if (monitoring !== undefined) try { action(monitoring); } catch { /* Monitoring cannot change worker execution. */ }
  };
  const localMappingJobs = new Map<string, Promise<void>>();
  const localMappingRetryAt = new Map<string, number>();
  const failures: unknown[] = [];
  const selectionVerifier = createNativeSelectionVerifier();
  try {
    signal.throwIfAborted();
    const local = await readWorkerLocalConfiguration(paths, signal);
    const { serverUrl, serverToken } = local;
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    lock = await acquireWorkerInstanceLock(paths);
    monitoring = createMonitoringObserver({ onDirty: () => monitoringSender?.markDirty() });
    signal.throwIfAborted();
    const workerId = await ensureWorkerIdentity(paths, signal);
    for (const directory of [paths.temporaryDirectory, paths.logsDirectory]) await mkdir(directory, { recursive: true, mode: 0o700 });
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    const emit = diagnostics.emit;
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
    const userId = await remote.currentUserId(signal);
    const observer = monitoring;
    monitoringSender = createMonitoringSender({ runId: observer.runId, capture: observer.capture,
      read: (operation, requestId) => remote.readMonitoring(workerId, operation, requestId),
      write: (revision, observation, operation, requestId) => remote.writeMonitoring(workerId, revision, observation, operation, requestId),
      deliverySuccess: observer.deliverySuccess, deliveryFailure: observer.deliveryFailure, emit });
    observeMonitoring(m => m.setPhase("configuration"));
    const currentPromptSource = createWorkerPromptSource({ serverOrigin: serverUrl, userId, workerId });
    promptSource = currentPromptSource;
    const readCloudConfiguration = async (readSignal: AbortSignal, operation?: Operation): Promise<WorkerCloudResource> => {
      try { return operation === undefined ? await remote.configuration(workerId, readSignal) : await remote.configuration(workerId, readSignal, operation); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) throw error;
        return { desired: null, observationRevision: "0", observation: null };
      }
    };
    let resource: WorkerCloudResource;
    try { resource = await readCloudConfiguration(signal); }
    catch (error) {
      if (!isWorkerCancellation(error, signal)) observeMonitoring(m => {
        m.setAdmission("partial", [{ code: "configuration-unavailable", scope: { kind: "worker" }, observedAt: new Date().toISOString(), nextAttemptAt: null }]);
        m.fail({ operationId: randomUUID(), component: "configuration", phase: "configuration", scope: { kind: "worker" }, error });
      });
      throw error;
    }
    const machine = machineDescription(platform);
    const prepared = new Map<string, WorkerProject>();
    const locallyKnownIds = new Set(workerLocalExplicitProjectIds(local, paths));
    const unboundMappings = new Map<string, number>(workerLocalUnboundRepositoryIndexes(local, paths).map(index => [`legacy:${index}`, index]));
    // Local mappings can retain Git-only owners even after cloud selection changes.
    const unobservedLocalMappings = new Set([...locallyKnownIds, ...unboundMappings.keys()]);
    const confirmedNoLocalMapping = new Set<string>();
    const getStore = (): ReturnType<typeof openWorkerStore> => store === undefined ? (store = openWorkerStore(paths.databaseFile)) : store;
    const getGit = (): ReturnType<typeof createWorkerGitManager> => git === undefined ? (git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory, reportPending: gitPendingReporter(emit), reportSettled: gitSettledReporter(emit) })) : git;
    const { admit: admitRepository } = createWorkerRepositoryAdmission({ paths, store: getStore });
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
    const readExecutionConfiguration = (context: import("./herdr.js").HerdrExecutionContext): ExecutionConfiguration | null => {
      const frozen = getStore().getNativeConfiguration(context);
      return frozen === null ? null : { ...frozen, agentControlMode: "herdr", recoveryLimit: configuration?.current().effective.recoveryLimit ?? workerConfigurationDefaults.recoveryLimit };
    };
    const sharedHerdr = (environment: Awaited<ReturnType<typeof prepareWorkerAgentEnvironment>>) => selectionHerdr ??= createSharedWorkerHerdr({ paths: platform === "macos" ? { ...paths, herdrDirectory: path.join(paths.herdrDirectory, "p"), logsDirectory: path.join(paths.herdrDirectory, "p", "logs") } : paths,
      homeDirectory: options.homeDirectory, ...environment, selectionVerifier, readExecutionConfiguration,
      hasResponsibilities: () => platform !== "macos" && getStore().listUnfinishedTasks().some(task => (task.agentControlMode ?? "herdr") === "herdr"),
    });
    tools = createWorkerToolSelectionRuntime({ workerDirectory: paths.workerDirectory, cwd: options.workingDirectory, environment: { ...process.env, ...toolEnvironment.agentEnvironment }, localToolPaths: local.toolPaths,
      admitHerdr: async (launch, operation) => sharedHerdr(await nativeApplication.prepareEnvironment()).prepareSelection(launch, operation),
      closeHerdr: async operation => { if (selectionHerdr !== undefined && (platform === "macos" || !getStore().listUnfinishedTasks().some(task => (task.agentControlMode ?? "herdr") === "herdr"))) await selectionHerdr.stopInstance(operation); },
      readActiveSelections: () => [...webToolSelections(options.homeDirectory, web), ...(platform === "macos" ? herdr?.lifecycle?.activeToolSelections?.() ?? retainedHerdrToolSelections(store) : selectionHerdr === undefined ? retainedHerdrToolSelections(store) : []), ...selectionHerdr?.activeToolSelections() ?? [], ...bots?.activeToolSelections() ?? []] });
    const toolRuntime = tools;
    let fallback: Awaited<ReturnType<typeof validateWorkerConfigurationSource>> | null = null;
    let fallbackRepositories: WorkerRepositoryAssignment[] = [];
    let fallbackTargets: string[] = [];
    let fallbackComplete = true;
    const discovered = new Map<string, string>();
    const view = (snapshot: WorkerConfigurationSnapshot): WorkerCoordinatorConfiguration | null => {
      if (snapshot.desired === null && fallback !== null) return {
        repositories: fallbackRepositories, targetProjectIds: fallbackTargets,
        readyProjectIds: fallbackRepositories.map(repository => repository.project.projectId),
        globalConfiguration: fallback, maxConcurrent: fallback.maxConcurrent, preferPlatformSpecificTasks: fallback.preferPlatformSpecificTasks,
      };
      const effective = snapshot.effective;
      if (effective.maxConcurrent === null || effective.recoveryLimit === null || effective.preferPlatformSpecificTasks === null) return null;
      const repositories: WorkerRepositoryAssignment[] = [];
      for (const project of effective.projects) {
        const binding = prepared.get(project.projectId);
        if (project.ready && project.native !== null && binding !== undefined) repositories.push({ project: binding, configuration: effectiveExecutionConfiguration(project.native, effective.agentControlMode!, effective.recoveryLimit, local) });
      }
      return { repositories, targetProjectIds: snapshot.desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: effective.projects.filter(project => project.ready && prepared.has(project.projectId)).map(project => project.projectId), globalConfiguration: effective.native === null ? null : effectiveExecutionConfiguration(effective.native, effective.agentControlMode!, effective.recoveryLimit, local), maxConcurrent: effective.maxConcurrent, recoveryLimit: effective.recoveryLimit, preferPlatformSpecificTasks: effective.preferPlatformSpecificTasks };
    };
    const transitions = new Map<string, string>();
    const preparationFailures = new Map<string, { operationId: string; observedAt: string; revision: string; successRevision: string | null }>();
    const fallbackPreparationFailures = new Map<string, { operationId: string; observedAt: string }>();
    const nativeFailures = new Map<string, { operationId: string; observedAt: string; target: WorkerCloudNative }>();
    const fallbackNativeFailures = new Map<string, { operationId: string; observedAt: string; target: WorkerCloudNative }>();
    const nativeActivities = new Map<string, { operationId: string; revision: string }>();
    let monitoringTargetSignature: string | undefined;
    let effectiveSignature = "";
    const reconcileWake = createReconcileWake();
    let scheduleInitialRemovals: (() => void) | undefined;
    configuration = await createWorkerConfigurationManager({
      file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal, localControlMode: local.agentControlMode, localToolPaths: local.toolPaths,
      ...toolRuntime.configurationOptions, applyNative: nativeApplication.apply,
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
        const incomplete = snapshot.desired === null
          ? fallback !== null && (!fallbackComplete || fallbackRepositories.length !== fallback.repositories.length)
          : !snapshot.synchronized || snapshot.effective.native === null || snapshot.desired.value.projects.some(project => {
            const effective = snapshot.effective.projects.find(value => value.projectId === project.projectId);
            return effective === undefined || !effective.ready || effective.native === null || !prepared.has(project.projectId);
          });
        observeMonitoring(m => m.setProjectPreparationIncomplete(incomplete));
        if (snapshot.desired !== null) observeMonitoring(m => m.setProjectPreparationUnknown(false));
        const selectedProjects = new Set(snapshot.desired?.value.projects.map(project => project.projectId) ?? []);
        if (snapshot.desired !== null) for (const [projectId, failure] of fallbackNativeFailures) {
          const project = snapshot.desired.value.projects.find(value => value.projectId === projectId);
          const scope = { kind: "project" as const, projectId };
          if (project !== undefined && isDeepStrictEqual(failure.target, resolveWorkerCloudProjectNative(snapshot.desired.value.native, project))) nativeFailures.set(`project/${projectId}`, failure);
          else observeMonitoring(m => { m.discardFailure(failure.operationId); m.setNativeConfigurationReason(scope, null); });
          fallbackNativeFailures.delete(projectId);
        }
        for (const [key, failure] of nativeFailures) {
          const projectId = key.startsWith("project/") ? key.slice("project/".length) : null;
          const project = projectId === null ? undefined : snapshot.desired?.value.projects.find(value => value.projectId === projectId);
          const target = snapshot.desired === null ? null : projectId === null ? snapshot.desired.value.native : project === undefined ? null : resolveWorkerCloudProjectNative(snapshot.desired.value.native, project);
          if (target === null || !isDeepStrictEqual(target, failure.target)) {
            const scope = projectId === null ? { kind: "worker" as const } : { kind: "project" as const, projectId };
            observeMonitoring(m => { m.discardFailure(failure.operationId); m.setNativeConfigurationReason(scope, null); });
            nativeFailures.delete(key);
          }
        }
        if (snapshot.desired !== null) for (const [projectId, failure] of fallbackPreparationFailures) {
          if (selectedProjects.has(projectId)) {
            const item = snapshot.items.find(value => value.key.kind === "projectPreparation" && value.key.projectId === projectId);
            preparationFailures.set(projectId, { ...failure, revision: item?.targetRevision ?? snapshot.desired.revision, successRevision: null });
          } else observeMonitoring(m => { m.discardFailure(failure.operationId); m.setProjectPreparationReason(projectId, null); });
          fallbackPreparationFailures.delete(projectId);
        }
        for (const [projectId, failure] of preparationFailures) {
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
        for (const project of snapshot.desired?.value.projects ?? []) {
          if (getStore().getProject({ projectId: project.projectId }) === null && !confirmedNoLocalMapping.has(project.projectId)) unobservedLocalMappings.add(project.projectId);
        }
        const signature = JSON.stringify(snapshot.effective);
        if (signature !== effectiveSignature) { effectiveSignature = signature; reporter?.publishInventory(null); reconcileWake.request(); }
        const current = view(snapshot);
        coordinator?.updateConfiguration(current ?? { repositories: [], targetProjectIds: snapshot.desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: snapshot.effective.maxConcurrent ?? 1, preferPlatformSpecificTasks: false });
        scheduleInitialRemovals?.();
        for (const item of snapshot.items) {
          const key = JSON.stringify(item.key), state = JSON.stringify([item.targetRevision, item.state, item.error]);
          if (transitions.get(key) === state) continue;
          transitions.set(key, state);
          emit({ kind: "worker-configuration", message: JSON.stringify({ desiredRevision: snapshot.desired?.revision, key: item.key, targetRevision: item.targetRevision, state: item.state, error: item.error }) });
        }
      },
      onError: error => { failures.push(error); cancellation.controller.abort(error); },
      onCapacity: revision => emit({ kind: "warning", message: `Worker configuration revision ${revision} is waiting for observation capacity; retained results remain available for acknowledgement.` }),
      onInvalidDesired: revision => emit({ kind: "warning", message: `Worker configuration revision ${revision} exceeds current limits; waiting for a valid target while retaining application results.` }),
    });
    await configuration.receive(resource.desired, resource.observationRevision);
    let bootstrap: WorkerCloudValue | null = null;
    if (resource.desired === null) {
      try { bootstrap = await parseWorkerCloudBootstrap(local.source, paths, resolveProject, signal); }
      catch (error) {
        if (signal.aborted || !projectUnavailable(error)) throw error;
        emit({ kind: "warning", message: "Worker configuration bootstrap could not be verified; retaining local project selection.", error });
        fallback = await validateWorkerConfigurationSource(local.source === undefined ? "{}" : local.source, paths, signal);
      }
    }
    const manager = configuration;
    const proofSignature = () => JSON.stringify(([ ["codex", "web"], ["copilot", "web"], ["codex", "herdr"], ["copilot", "herdr"], ["herdr", "herdr"] ] as const).map(([tool, context]) => toolRuntime.manager.currentSelection(tool, context)?.selectionKey));
    let observedToolProof = proofSignature();
    const refreshToolProofs = (): Promise<void> | undefined => {
      const current = proofSignature(); if (current === observedToolProof) return;
      observedToolProof = current; return manager.refreshToolSelections();
    };
    modelDiscovery = createWorkerModelDiscovery({
      prepare: async (provider, operation) => { if (provider === "codex" || provider === "copilot") await toolRuntime.manager.prepare(provider, "web", operation); },
      defaultCwd: options.workingDirectory, environment: { ...process.env, ...toolEnvironment.agentEnvironment }, verifier: { discover: async (input, operation) => {
        if (input.native.agent !== "codex" && input.native.agent !== "copilot") return selectionVerifier.discover(input, operation);
        const toolLaunch = await toolRuntime.manager.selectForNewExecution(input.native.agent, "web", operation);
        return toolRuntime.inspector.discover({ ...input, toolLaunch, mode: "web", toolRuntimeRoot: toolRuntime.toolRuntimeRoot }, operation);
      } },
      configuration: () => {
        const native = manager.current().effective.native;
        if (native === null) throw new WorkerModelDiscoveryError("capability_error");
        return { ...normalizeWorkerNative(native, "web", local, false), toolSelections: ["codex", "copilot"].map(tool => toolRuntime.manager.currentSelection(tool as "codex" | "copilot", "web")?.selectionKey ?? null) };
      },
    });
    const executeReadOnly = async <K extends WorkerReadOnlyOperation>(operation: K, input: WorkerReadOnlyOperations[K]["input"], requestSignal: AbortSignal): Promise<WorkerReadOnlyOperations[K]["result"]> => {
      const result = operation === "directory.list"
        ? await browseWorkerDirectory(input as WorkerDirectoryInput, { defaultCwd: options.workingDirectory, signal: requestSignal })
        : await modelDiscovery!.discover(input as WorkerModelInput, requestSignal);
      return result as WorkerReadOnlyOperations[K]["result"];
    };
    readOnly = createWorkerReadOnlyChannel({ serverOrigin: serverUrl, serverToken, ownerUserId: userId, workerId,
      configurationSignature: () => JSON.stringify([manager.current().effective, local.agentModel, local.agentReasoningEffort, toolRuntime.manager.currentSelection("codex", "web")?.selectionKey, toolRuntime.manager.currentSelection("copilot", "web")?.selectionKey]),
      execute: executeReadOnly,
      onInvalidate: () => modelDiscovery?.invalidate(),
      onError: message => emit({ kind: "worker-readonly", message }),
    });
    const scheduleLocalMappingChecks = (): void => {
      for (const projectId of unobservedLocalMappings) {
        if (localMappingJobs.has(projectId) || (localMappingRetryAt.get(projectId) ?? 0) > Date.now()) continue;
        const unboundIndex = unboundMappings.get(projectId);
        if (unboundIndex === undefined && !locallyKnownIds.has(projectId) && manager.current().desired?.value.projects.some(project => project.projectId === projectId)) continue;
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
                const operation = createOperation({ signal });
                try {
                  const worktrees = await getGit().listWorktrees({ projectId: "00000000-0000-4000-8000-000000000000", repoUrl: mapping.remote, localPath: mapping.path }, operation, false, true);
                  if (worktrees.length > 0) throw new Error("A local repository with an invalid Project ID contains managed resources.");
                } finally { operation.dispose(); }
                unobservedLocalMappings.delete(projectId);
                return;
              }
              const project = await resolveProject({ repoUrl: mapping.remote }, signal);
              const operation = createOperation({ signal });
              try {
                const scan = await getGit().scanWorktrees({ projectId: project.id, repoUrl: mapping.remote, localPath: mapping.path }, operation, false, true);
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
    const refreshFallback = async (): Promise<void> => {
      if (fallback === null || manager.current().desired !== null) return;
      bootstrap = null;
      const current = fallback;
      const repositories: WorkerRepositoryAssignment[] = [];
      const targets = new Set(current.repositories.flatMap(repository => {
        const id = repository.projectId ?? discovered.get(repository.remote);
        return id === undefined ? [] : [id];
      }));
      fallbackTargets = [...targets];
      for (const id of targets) if (getStore().getProject({ projectId: id }) === null) unobservedLocalMappings.add(id);
      let allAccessible = true;
      let allIdentified = true;
      for (const repository of current.repositories) {
        signal.throwIfAborted();
        let projectId = repository.projectId ?? discovered.get(repository.remote);
        let resolving = false;
        let nativeFailed = false;
        let activityId: string | undefined;
        const startPreparation = (id: string): void => {
          if (activityId !== undefined) return;
          const previous = fallbackPreparationFailures.get(id);
          observeMonitoring(m => {
            if (previous !== undefined) { m.updateFailureRetry(previous.operationId, "running"); m.setProjectPreparationReason(id, { observedAt: previous.observedAt, nextAttemptAt: null }); }
            activityId = m.startActivity({ kind: "maintenance", phase: "project-preparation", scope: { kind: "project", projectId: id } });
          });
        };
        if (projectId !== undefined) startPreparation(projectId);
        if (projectId !== undefined) targets.add(projectId);
        try {
          if (projectId !== undefined && getStore().getProject({ projectId }) === null) {
            await admitLocalBinding({ projectId, repoUrl: repository.remote, localPath: repository.path }, signal);
          }
          resolving = true;
          const project = await resolveProject({ repoUrl: repository.remote, ...(projectId === undefined ? {} : { projectId }) }, signal);
          resolving = false;
          projectId = project.id;
          startPreparation(projectId);
          discovered.set(repository.remote, projectId);
          targets.add(projectId);
          fallbackTargets = [...targets];
          const binding = await resolveBinding(projectId, signal);
          if (!prepared.has(projectId)) {
            await reserveRepository(binding, signal);
            try {
              const operation = createOperation({ signal });
              try { await getGit().prepareRepository(binding, operation); }
              finally { operation.dispose(); }
              const nativeTarget = { agent: repository.agent, model: repository.model, args: repository.args }, nativeScope = { kind: "project" as const, projectId };
              let nativeActivity: string | undefined;
              const nativeFailure = fallbackNativeFailures.get(projectId);
              observeMonitoring(m => {
                if (nativeFailure !== undefined) { m.updateFailureRetry(nativeFailure.operationId, "running"); m.setNativeConfigurationReason(nativeScope, { observedAt: nativeFailure.observedAt, nextAttemptAt: null }); }
                nativeActivity = m.startActivity({ kind: "maintenance", phase: "configuration", scope: nativeScope });
              });
              try {
                await nativeApplication.apply(nativeTarget, signal, local.agentControlMode);
                const recovered = fallbackNativeFailures.get(projectId);
                if (recovered !== undefined && !signal.aborted && manager.current().desired === null && isDeepStrictEqual(recovered.target, nativeTarget)) {
                  observeMonitoring(m => { m.recover(recovered.operationId); m.setNativeConfigurationReason(nativeScope, null); }); fallbackNativeFailures.delete(projectId);
                }
              } catch (error) {
                nativeFailed = true;
                if (!signal.aborted && manager.current().desired === null) {
                  const observedAt = new Date().toISOString(), operationId = fallbackNativeFailures.get(projectId)?.operationId ?? randomUUID();
                  fallbackNativeFailures.set(projectId, { operationId, observedAt, target: nativeTarget });
                  observeMonitoring(m => { m.fail({ operationId, component: "configuration", phase: "configuration", scope: nativeScope, error }); m.setNativeConfigurationReason(nativeScope, { observedAt, nextAttemptAt: null }); });
                }
                throw error;
              } finally {
                if (signal.aborted) { const failure = fallbackNativeFailures.get(projectId); if (failure !== undefined) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setNativeConfigurationReason(nativeScope, { observedAt: failure.observedAt, nextAttemptAt: null }); }); }
                if (nativeActivity !== undefined) observeMonitoring(m => m.endActivity(nativeActivity!));
              }
              prepared.set(projectId, await admitRepository(binding, signal));
            } finally { reservations.delete(projectId); }
          }
          repositories.push({ project: prepared.get(projectId)!, configuration: repository });
          if (activityId !== undefined && !signal.aborted) observeMonitoring(m => m.updateActivity(activityId!, { progress: true }));
          const recovered = fallbackPreparationFailures.get(projectId);
          if (recovered !== undefined && !signal.aborted && manager.current().desired === null) { observeMonitoring(m => { m.recover(recovered.operationId); m.setProjectPreparationReason(projectId!, null); }); fallbackPreparationFailures.delete(projectId); }
        } catch (error) {
          if (signal.aborted && projectId !== undefined) {
            const failure = fallbackPreparationFailures.get(projectId);
            if (failure !== undefined) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setProjectPreparationReason(projectId!, { observedAt: failure.observedAt, nextAttemptAt: null }); });
          }
          if (!signal.aborted && !nativeFailed && manager.current().desired === null) {
            if (projectId === undefined) observeMonitoring(m => m.setProjectPreparationUnknown(true));
            else {
              const observedAt = new Date().toISOString(), operationId = fallbackPreparationFailures.get(projectId)?.operationId ?? randomUUID();
              fallbackPreparationFailures.set(projectId, { operationId, observedAt });
              observeMonitoring(m => { m.fail({ operationId, component: "project", phase: "project-preparation", scope: { kind: "project", projectId: projectId! }, error }); m.setProjectPreparationReason(projectId!, { observedAt, nextAttemptAt: null }); });
            }
          }
          if (signal.aborted || error instanceof ProtocolError || error instanceof ApiError && !projectUnavailable(error) || resolving && !projectUnavailable(error)) {
            reporter?.publishInventory(null);
            throw error;
          }
          if (projectUnavailable(error)) allAccessible = false;
          if (projectId === undefined) allIdentified = false;
          emit({ kind: "warning", message: `Worker repository ${projectId ?? repository.remote} could not be prepared.`, error });
        } finally {
          if (signal.aborted && projectId !== undefined) {
            const failure = fallbackPreparationFailures.get(projectId);
            if (failure !== undefined) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setProjectPreparationReason(projectId!, { observedAt: failure.observedAt, nextAttemptAt: null }); });
          }
          if (activityId !== undefined) observeMonitoring(m => m.endActivity(activityId!));
        }
      }
      fallbackTargets = [...targets];
      fallbackRepositories = repositories;
      fallbackComplete = allIdentified;
      if (manager.current().desired === null) observeMonitoring(m => m.setProjectPreparationIncomplete(!allIdentified || repositories.length !== current.repositories.length));
      if (allIdentified) observeMonitoring(m => m.setProjectPreparationUnknown(false));
      if (allAccessible && allIdentified) {
        try { bootstrap = await parseWorkerCloudBootstrap(local.source, paths, resolveProject, signal); }
        catch (error) { if (signal.aborted || !projectUnavailable(error)) throw error; emit({ kind: "warning", message: "Worker configuration bootstrap could not be verified.", error }); }
      }
    };
    let initialRemovalsComplete = false;
    let initialRemovalsJob: Promise<void> | undefined;
    // Keep progress across capacity retries, but require a new coordinator to observe each binding again.
    const initialRemovalsRegistered = new Set<string>();
    const ensureInitialRemovals = (): Promise<void> => {
      if (initialRemovalsComplete || manager.current().desired === null) return Promise.resolve();
      if (initialRemovalsJob !== undefined) return initialRemovalsJob;
      const job = (async () => {
        for (const project of getStore().listProjects()) {
          signal.throwIfAborted();
          if (initialRemovalsRegistered.has(project.projectId)) continue;
          await manager.ensureProjectRemoval(project.projectId);
          initialRemovalsRegistered.add(project.projectId);
        }
        initialRemovalsComplete = true;
      })();
      initialRemovalsJob = job;
      initialRemovalReconciliation = job;
      void job.finally(() => { if (initialRemovalsJob === job) initialRemovalsJob = undefined; }).catch(() => undefined);
      return job;
    };
    bots = createWorkerBotHost({ ...options, selectToolLaunch: toolRuntime.selectToolLaunch, toolObservationFor: toolRuntime.toolObservationFor, toolRuntimeRoot: toolRuntime.toolRuntimeRoot, toolInspector: toolRuntime.hostInspector, toolLaunchForHost: agent => toolRuntime.manager.currentSelection(agent, "web"), paths, owner: { serverOrigin: serverUrl, ownerUserId: userId, workerId }, serverToken, emit,
      configuration: () => {
        const effective = manager.current().effective;
        // Assistant capability collection owns per-Provider Web argument failures.
        // Keep Herdr-only defaults observable without failing the whole Worker report.
        return effective.native === null || effective.recoveryLimit === null ? null : {
          ...normalizeWorkerNative(effective.native, "web", local, false).native,
          agentControlMode: "web", recoveryLimit: effective.recoveryLimit,
          ...(local.agentModel !== undefined || local.agentReasoningEffort !== undefined ? { validateNativeSelection: true as const } : {}),
        };
      },
      pollIntervalMs: () => manager.current().effective.pollIntervalMs,
      recoveryLimit: () => manager.current().effective.recoveryLimit,
    });
    botRun = bots.run(signal).catch(error => { failures.push(error); cancellation.controller.abort(error); });
    let reconcileReport = false;
    const telemetry = createWorkerTelemetryCollector({ paths, homeDirectory: options.homeDirectory, version: options.version, workingDirectory: options.workingDirectory, machine, platform, workerId, serverOrigin: serverUrl, assistantHost: bots, toolPaths: { context: () => manager.current().effective.agentControlMode ?? local.agentControlMode, snapshot: () => toolRuntime.manager.snapshot() } });
    reporter = createWorkerReporter({ signal, collect: async operation => {
      const sample = await telemetry.collect(operation);
      const snapshot = manager.current();
      const localFallback = snapshot.desired === null && fallback !== null;
      const effective = localFallback ? {
        native: fallback,
        projects: fallbackRepositories.map(repository => ({ projectId: repository.project.projectId, native: repository.configuration })),
      } : snapshot.effective;
      const runtimeConfiguration = workerRuntimeConfigurationReport(effective, localFallback ? local.agentControlMode : snapshot.effective.agentControlMode ?? local.agentControlMode, local, localFallback ? "local" : "cloud");
      return { ...sample, telemetry: { ...sample.telemetry, ...(runtimeConfiguration === undefined ? {} : { runtimeConfiguration }) } };
    }, send: (report, operation) => remote.report(workerId, report, operation), emit,
      configuration: {
        prompts: currentPromptSource,
        prepare: async operation => {
          if (!reconcileReport && manager.current().synchronized) return;
          const actual = await readCloudConfiguration(operation.signal, operation);
          await manager.receive(actual.desired, actual.observationRevision);
          if (actual.desired !== null) bootstrap = null;
          reconcileReport = false;
        },
        capture: () => {
          const captured = manager.report(manager.current().desired === null ? bootstrap : null);
          try { parseWorkerCloudReport(captured, { controlMode: Object.hasOwn(captured, "controlModeBootstrap"), toolPaths: Object.hasOwn(captured, "toolPathsBootstrap") }); }
          catch (error) { reconcileReport = true; throw error; }
          return captured;
        },
        send: async (report, captured, operation, selectors) => {
          try { return await remote.reportConfiguration(workerId, report, captured, operation, selectors); }
          catch (error) {
            if (!(error instanceof ApiError) || error.outcomeUnconfirmed || error.status === 400 && error.code === "invalid_input" || error.phase === "prepare" && error.cause instanceof OperationError && error.cause.kind === "request_limit") reconcileReport = true;
            if (error instanceof ApiError && error.status === 404 && error.code === "not_found" && manager.current().desired === null && captured.bootstrap !== null) {
              bootstrap = null;
              fallback ??= await validateWorkerConfigurationSource(local.source === undefined ? "{}" : local.source, paths, operation.signal);
            }
            throw error;
          }
        },
        accept: async (sent, receipt) => {
          await manager.acknowledge(sent, receipt);
          if (receipt.desired !== null) bootstrap = null;
          // Report projections cannot advertise later upgrades; rediscover each missing capability.
          if (receipt.desired?.value.agentControlMode === undefined || receipt.desired?.value.toolPaths === undefined) reconcileReport = true;
        },
      },
    });
    scheduleInitialRemovals = () => { if (!signal.aborted) void ensureInitialRemovals().catch(error => { if (!signal.aborted) emit({ kind: "reconciliation-error", message: "Retained project removal reconciliation failed; configuration reporting remains active.", error }); }); };
    scheduleInitialRemovals();
    signal.throwIfAborted();
    const lazyHerdr = (environment: Awaited<ReturnType<typeof prepareWorkerAgentEnvironment>>): WorkerHerdrAdapter => new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => {
      herdr = herdr === undefined ? platform === "macos" ? createDurableWorkerHerdr({ paths, selectionVerifier, readExecutionConfiguration, homeDirectory: options.homeDirectory, ...environment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask, currentUserId: remote.currentUserId }) : sharedHerdr(environment) : herdr;
      return Reflect.get(herdr, property);
    } });
    let coordinatorJob: Promise<ReturnType<typeof createWorkerCoordinator>> | undefined;
    const ensureCoordinator = (): Promise<ReturnType<typeof createWorkerCoordinator>> => {
      if (coordinator !== undefined) return Promise.resolve(coordinator);
      if (coordinatorJob !== undefined) return coordinatorJob;
      const job = (async () => {
        const currentStore = getStore();
        if (web === undefined) web = await createWebRuntime(options, paths, currentStore, getGit(), serverUrl, serverToken, platform, emit, signal, currentPromptSource, undefined, observer, toolRuntime);
        if (renewal === undefined) renewal = maintainWorkerControllerGrants({ homeDirectory: options.homeDirectory, serverOrigin: serverUrl, store: web.webStore, launcher: web.launcher, signal,
          onError: message => emit({ kind: "credential-renewal-error", message }),
        }).catch(error => { failures.push(error); cancellation.controller.abort(error); });
        const environment = await nativeApplication.prepareEnvironment();
        signal.throwIfAborted();
        const current = view(manager.current()) ?? { repositories: [], targetProjectIds: manager.current().desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: 1, preferPlatformSpecificTasks: false };
        coordinator = createWorkerCoordinator({ freezeConfiguration: toolRuntime.freezeConfiguration, store: currentStore, git: getGit(), herdr: lazyHerdr(environment), ...web, remote, serverOrigin: serverUrl, workerId, platform, machine, ...current,
          monitoring: observer,
          hasHerdrJournal: await hasHerdrJournal(paths, platform),
          availableDiskBytes: () => { const fs = statfsSync(paths.workerDirectory, { bigint: true }); return fs.bavail * fs.bsize; },
          onInventory: inventory => {
            const desired = manager.current().desired;
            const complete = unobservedLocalMappings.size === 0 && (desired === null ? fallbackComplete : desired.value.projects.every(project => currentStore.getProject({ projectId: project.projectId }) !== null));
            reporter!.publishInventory(complete ? inventory : null);
          },
          configurationComplete: () => {
            const desired = manager.current().desired;
            return (desired !== null || fallbackComplete) && unobservedLocalMappings.size === 0;
          },
          onClaim: reporter!.recordClaim,
          requestReconcile: reconcileWake.request,
          promptSource: currentPromptSource,
          onPromptDemand: projectIds => { if (currentPromptSource.setDemand(projectIds)) reporter!.demandChanged(); },
          buildPrompt: web.buildPrompt, emit, signal });
        const latest = view(manager.current());
        coordinator.updateConfiguration(latest ?? { repositories: [], targetProjectIds: manager.current().desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: manager.current().effective.maxConcurrent ?? 1, preferPlatformSpecificTasks: false });
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
          if (!manager.current().desired?.value.projects.some(project => project.projectId === projectId)) await manager.ensureProjectRemoval(projectId);
        } finally { reservations.delete(projectId); }
        const failure = preparationFailures.get(projectId);
        if (failure !== undefined && revision !== undefined && !applicationSignal.aborted) failure.successRevision = revision;
        if (activityId !== undefined && !applicationSignal.aborted) observeMonitoring(m => m.updateActivity(activityId!, { progress: true }));
      } catch (error) {
        const current = manager.current();
        const item = current.items.find(value => value.key.kind === "projectPreparation" && value.key.projectId === projectId);
        if (applicationSignal.aborted) {
          const failure = preparationFailures.get(projectId);
          if (failure !== undefined) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "none"); m.setProjectPreparationReason(projectId, { observedAt: failure.observedAt, nextAttemptAt: null }); });
        }
        if (!applicationSignal.aborted && revision !== undefined && item?.targetRevision === revision && current.desired?.value.projects.some(project => project.projectId === projectId)) {
          const observedAt = new Date().toISOString(), operationId = preparationFailures.get(projectId)?.operationId ?? randomUUID();
          preparationFailures.set(projectId, { operationId, observedAt, revision, successRevision: null });
          observeMonitoring(m => {
            m.fail({ operationId, component: "project", phase: "project-preparation", scope: { kind: "project", projectId }, error });
            m.setProjectPreparationReason(projectId, { observedAt, nextAttemptAt: null });
          });
        }
        throw error;
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
    let attachmentShown = false, started = false, archiveDeferred = false;
    const archiveShouldYield = (): boolean => {
      const yielding = coordinator?.archiveYield() ?? true;
      if (yielding && !archiveDeferred) emit({ kind: "session-archive-deferred", message: "Completed session archive backfill is deferred while cleanup is pending or worker capacity is full." });
      archiveDeferred = yielding;
      return yielding;
    };
    observeMonitoring(m => m.setLifecycle("running"));
    while (!signal.aborted) {
      const revision = reconcileWake.snapshot();
      void toolRuntime.prepareWebCandidates(signal).then(changed => changed && !signal.aborted ? refreshToolProofs() : undefined).catch(error => { if (!signal.aborted) emit({ kind: "warning", message: "Worker tool selection observation could not be published.", error }); });
      const configuredMode = manager.current().desired?.value.agentControlMode ?? manager.current().effective.agentControlMode ?? fallback?.agentControlMode;
      if (configuredMode === "herdr") void toolRuntime.prepareHerdrCandidate(signal).then(changed => {
        if (!changed || signal.aborted) return;
        reconcileWake.request(); return refreshToolProofs();
      }).catch(error => { if (!signal.aborted) emit({ kind: "warning", message: "Herdr instance admission could not be refreshed.", error }); });
      try {
        const refreshedProofs = refreshToolProofs(); if (refreshedProofs !== undefined) await refreshedProofs;
        observeMonitoring(m => m.setPhase("configuration"));
        scheduleLocalMappingChecks();
        await refreshFallback();
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
        if (!started) { emit({ kind: "started", message: `Foreground worker ${workerId} on ${platform}; cloud-managed configuration; logs=${diagnostics.filename}.` }); started = true; }
        if (!attachmentShown && herdr !== undefined) { emit({ kind: "attach", message: "Run daynight worker attach in another terminal for native input." }); attachmentShown = true; }
      } catch (error) {
        if (isWorkerCancellation(error, signal)) break;
        if (signal.aborted) throw error;
        observeMonitoring(m => { m.setAdmission("unknown", []); m.staleCapacity(); });
        emit({ kind: "reconciliation-error", message: "The reconciliation round failed; configuration reporting remains active and resources remain for the next successful observation.", error });
      }
      await diagnostics.flush();
      if (signal.aborted) break;
      const interval = manager.current().effective.pollIntervalMs ?? (manager.current().desired === null ? fallback?.pollIntervalMs ?? null : null);
      observeMonitoring(m => { m.setPhase("waiting-poll"); m.setNextPoll(new Date(Date.now() + (interval ?? 1_000)).toISOString()); });
      if (reconcileWake.snapshot() === revision && fallback !== null && manager.current().desired === null) {
        const nextAttemptAt = new Date(Date.now() + (interval ?? 1_000)).toISOString();
        for (const [projectId, failure] of fallbackPreparationFailures) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "scheduled", nextAttemptAt); m.setProjectPreparationReason(projectId, { observedAt: failure.observedAt, nextAttemptAt }); });
        for (const [projectId, failure] of fallbackNativeFailures) observeMonitoring(m => { m.updateFailureRetry(failure.operationId, "scheduled", nextAttemptAt); m.setNativeConfigurationReason({ kind: "project", projectId }, { observedAt: failure.observedAt, nextAttemptAt }); });
      }
      try { await reconcileWake.waitAfter(revision, interval ?? 1_000, signal); }
      catch (error) { if (!isWorkerCancellation(error, signal)) throw error; }
      observeMonitoring(m => m.setNextPoll(null));
    }
  } catch (error) {
    if (!isWorkerCancellation(error, signal)) failures.push(error);
  } finally {
    observeMonitoring(m => { m.setLifecycle("stopping"); m.setPhase("stopping"); });
    if (!signal.aborted) cancellation.controller.abort(new Error("Worker runtime is closing."));
    readOnly?.close();
    modelDiscovery?.close();
    await Promise.allSettled([...localMappingJobs.values()]);
    await renewal;
    try { await reporter?.stop(); } catch (error) { failures.push(error); }
    promptSource?.close();
    try { await initialRemovalReconciliation; } catch { /* The reconciliation failure was reported when it occurred. */ }
    try { await configuration?.stop(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
    if (coordinator !== undefined || bots !== undefined) {
      try {
        diagnostics?.emit({ kind: "shutdown", message: "Stopping agents while retaining unfinished claims, worktrees and native session IDs." });
        await shutdownWorkerExecutions({ ...(coordinator === undefined ? {} : { tasks: async () => {
          if (!await coordinator!.shutdown()) throw new Error("Some task resources could not be confirmed stopped and closed; the private Herdr instance was retained.");
          const operation = createOperation({ limits: { totalMs: 30_000 } });
          try { if (herdr !== undefined && herdr.lifecycle === undefined) await herdr.stopInstance(operation); }
          finally { operation.dispose(); }
        } }), ...(bots === undefined ? {} : { bots: () => bots!.shutdown() }) });
      } catch (error) { if (!failures.includes(error)) failures.push(error); }
    }
    await botRun;
    try { await web?.archiveMaintenance.close(); } catch (error) { failures.push(error); }
    observeMonitoring(m => { m.clearActivities(); m.setLifecycle("stopped"); m.setPhase("stopped"); });
    try { await monitoringSender?.finish(); } catch { /* Monitoring delivery does not change shutdown. */ }
    try { await bots?.close(); } catch (error) { failures.push(error); }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { web?.webStore.close(); } catch (error) { failures.push(error); }
    try { herdr?.lifecycle?.close(); } catch (error) { failures.push(error); }
    try { await selectionVerifier.close(); } catch (error) { failures.push(error); }
    try { await tools?.close(); } catch (error) { failures.push(error); }
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await diagnostics?.flush(); } catch (error) { failures.push(error); }
    try { await lock?.release(); } catch (error) { failures.push(error); }
    cancellation.dispose();
  }
  throwFailures(failures);
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
  let actualHerdr: WorkerHerdrAdapter | undefined;
  let selectionHerdr: ReturnType<typeof createSharedWorkerHerdr> | undefined;
  let configurationManager: WorkerConfigurationManager | undefined;
  let controlPromptSource: ReturnType<typeof createWorkerPromptSource> | undefined;
  let controlResource: WorkerCloudResource | undefined;
  const failures: unknown[] = [];
  const selectionVerifier = createNativeSelectionVerifier();
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
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    await mkdir(paths.temporaryDirectory, { recursive: true, mode: 0o700 });
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory, reportPending: gitPendingReporter(diagnostics.emit), reportSettled: gitSettledReporter(diagnostics.emit) });
    const nativeApplication = nativeConfigurationApplication({ tools: () => tools, paths, homeDirectory: options.homeDirectory, workingDirectory: options.homeDirectory, overrides: local, signal, emit: diagnostics.emit });
    const toolEnvironment = { agentEnvironment: { DN_CONFIG_DIR: paths.stateDirectory } };
    const readExecutionConfiguration = (context: import("./herdr.js").HerdrExecutionContext): ExecutionConfiguration | null => {
      const frozen = store!.getNativeConfiguration(context);
      return frozen === null ? null : { ...frozen, agentControlMode: "herdr", recoveryLimit: configurationManager?.current().effective.recoveryLimit ?? workerConfigurationDefaults.recoveryLimit };
    };
    const sharedHerdr = (environment: Awaited<ReturnType<typeof prepareWorkerAgentEnvironment>> | {}) => selectionHerdr ??= createSharedWorkerHerdr({ paths: platform === "macos" ? { ...paths, herdrDirectory: path.join(paths.herdrDirectory, "p"), logsDirectory: path.join(paths.herdrDirectory, "p", "logs") } : paths,
      homeDirectory: options.homeDirectory, ...environment, selectionVerifier, readExecutionConfiguration,
      hasResponsibilities: () => platform !== "macos" && store!.listUnfinishedTasks().some(task => (task.agentControlMode ?? "herdr") === "herdr"),
    });
    tools = createWorkerToolSelectionRuntime({ workerDirectory: paths.workerDirectory, cwd: options.homeDirectory, environment: { ...process.env, ...toolEnvironment.agentEnvironment }, localToolPaths: local.toolPaths,
      admitHerdr: async (launch, operation) => sharedHerdr(await nativeApplication.prepareEnvironment()).prepareSelection(launch, operation),
      closeHerdr: async operation => { if (selectionHerdr !== undefined && platform === "macos") await selectionHerdr.stopInstance(operation); },
      readActiveSelections: () => [...webToolSelections(options.homeDirectory, web), ...(platform === "macos" ? actualHerdr?.lifecycle?.activeToolSelections?.() ?? retainedHerdrToolSelections(store) : selectionHerdr === undefined ? retainedHerdrToolSelections(store) : []), ...selectionHerdr?.activeToolSelections() ?? []] });
    const toolRuntime = tools;
    let coordinatorConfiguration: WorkerCoordinatorConfiguration = { repositories: [], globalConfiguration: null, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    const sources = store.listTasks().filter(task => task.taskId === options.request.taskId && task.claimId === options.request.claimId && (options.request.projectId === undefined || task.projectId === options.request.projectId));
    if (sources.length > 1) throw new Error("The source claim is ambiguous; supply --project.");
    const targetProjectId = sources[0]?.projectId ?? options.request.projectId;
    const frozenRetry = options.request.kind === "retry" && sources.length === 1 && (sources[0]!.agentControlMode === "web" || store.getNativeConfiguration(sources[0]!) !== null);
    if (options.request.kind !== "release" && !frozenRetry) {
      let resource: WorkerCloudResource;
      try { resource = await remote.configuration(workerId, signal); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) throw error;
        resource = { desired: null, observationRevision: "0", observation: null };
      }
      controlResource = resource;
      if (resource.desired === null) {
        const initial = await validateWorkerConfigurationSource(local.source === undefined ? "{}" : local.source, paths, signal);
        const repositories: WorkerRepositoryAssignment[] = [];
        if (targetProjectId === undefined && initial.repositories.length > 1) throw new Error("This claim has no local execution; supply --project to resume it explicitly.");
        for (const repository of initial.repositories) {
          if (targetProjectId !== undefined && repository.projectId !== undefined && repository.projectId !== targetProjectId) continue;
          try {
            const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, signal);
            if (targetProjectId !== undefined && project.id !== targetProjectId) continue;
            const binding = store.registerProject({ projectId: project.id, repoUrl: repository.remote, localPath: repository.path });
            repositories.push({ project: binding, configuration: repository });
          } catch (error) {
            if (signal.aborted || repository.projectId === targetProjectId || targetProjectId === undefined || error instanceof ProtocolError || error instanceof ApiError && !projectUnavailable(error)) throw error;
            diagnostics.emit({ kind: "warning", message: "An unrelated worker repository could not be resolved for management.", error });
          }
        }
        coordinatorConfiguration = { repositories, globalConfiguration: initial, maxConcurrent: initial.maxConcurrent, preferPlatformSpecificTasks: initial.preferPlatformSpecificTasks };
      } else {
        configurationManager = await createWorkerConfigurationManager({ file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal, localControlMode: local.agentControlMode, localToolPaths: local.toolPaths, ...toolRuntime.configurationOptions, onChange: snapshot => { toolRuntime.setTargets(snapshot.toolTargets); }, applyNative: nativeApplication.apply });
        await configurationManager.receive(resource.desired, resource.observationRevision);
        await configurationManager.settle();
        const effective = configurationManager.current().effective;
        if (effective.maxConcurrent === null || effective.recoveryLimit === null || effective.preferPlatformSpecificTasks === null) throw new Error("The Worker's cloud runtime parameters are unavailable.");
        const globalConfiguration = effective.native === null ? null : effectiveExecutionConfiguration(effective.native, effective.agentControlMode!, effective.recoveryLimit, local);
        const repositories = store.listProjects().flatMap(project => {
          const selected = effective.projects.find(value => value.projectId === project.projectId);
          const native = selected === undefined ? effective.native : selected.native;
          return native === null ? [] : [{ project, configuration: effectiveExecutionConfiguration(native, effective.agentControlMode!, effective.recoveryLimit!, local) }];
        });
        coordinatorConfiguration = { repositories, readyProjectIds: store.listProjects().map(project => project.projectId), globalConfiguration, maxConcurrent: effective.maxConcurrent, recoveryLimit: effective.recoveryLimit, preferPlatformSpecificTasks: effective.preferPlatformSpecificTasks };
      }
    }
    const agentEnvironment = options.request.kind === "retry" ? nativeApplication.current() === undefined ? await prepareWorkerAgentEnvironment(paths, diagnostics.emit, signal) : nativeApplication.current()! : {};
    const herdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => { actualHerdr ??= platform === "macos" ? createDurableWorkerHerdr({ paths, selectionVerifier, readExecutionConfiguration, homeDirectory: options.homeDirectory, ...agentEnvironment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask, currentUserId: remote.currentUserId }) : sharedHerdr(agentEnvironment); return Reflect.get(actualHerdr, property); } });
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
        const telemetry = createWorkerTelemetryCollector({ paths, homeDirectory: options.homeDirectory, version: options.version, workingDirectory: options.homeDirectory, machine, platform, workerId, serverOrigin: serverUrl, toolPaths: { context: () => configurationManager?.current().effective.agentControlMode ?? local.agentControlMode, snapshot: () => toolRuntime.manager.snapshot() } });
        const sample = await telemetry.collect(operation);
        const cleanupFailure = sample.issues.find(issue => hasUnconfirmedHerdrCommandCleanup(issue.error));
        if (cleanupFailure !== undefined) throw cleanupFailure.error;
        let bootstrap: WorkerCloudValue | null = null;
        const outcome = await syncWorkerConfigurationOnce({ operation, report: () => ({ ...sample.telemetry, taskInventory: null }), configuration: {
          prompts: retryPromptSource,
          prepare: async current => {
            if (configurationManager === undefined) {
              let resource = controlResource;
              if (resource === undefined) {
                try { resource = await remote.configuration(workerId, current.signal, current); }
                catch (error) {
                  if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) throw error;
                  resource = { desired: null, observationRevision: "0", observation: null };
                }
              }
              configurationManager = await createWorkerConfigurationManager({ file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal, localControlMode: local.agentControlMode, localToolPaths: local.toolPaths, ...toolRuntime.configurationOptions, onChange: snapshot => { toolRuntime.setTargets(snapshot.toolTargets); }, applyNative: nativeApplication.apply });
              await configurationManager.receive(resource.desired, resource.observationRevision);
              if (resource.desired === null) bootstrap = await parseWorkerCloudBootstrap(local.source, paths, remote.resolveProject, current.signal);
            }
          },
          capture: () => configurationManager!.report(bootstrap),
          send: (report, captured, current, selectors) => remote.reportConfiguration(workerId, report, captured, current, selectors),
          accept: async (captured, receipt) => { await configurationManager!.acknowledge(captured, receipt); },
        } });
        if (outcome.promptError || retryPromptSource.current(projectId) === null) diagnostics!.emit({ kind: "warning", message: "Worker prompt synchronization is unavailable; new input remains waiting." });
      } catch (error) {
        if (signal.aborted || inputSignal?.aborted || hasUnconfirmedHerdrCommandCleanup(error)) throw error;
        diagnostics!.emit({ kind: "warning", message: "Worker prompt synchronization failed; new input remains waiting." });
      } finally { operation.dispose(); }
    };
    web = await createWebRuntime(options, paths, store, git, serverUrl, serverToken, platform, diagnostics.emit, signal, retryPromptSource, preparePromptSource, undefined, toolRuntime);
    if (frozenRetry) {
      const original = sources[0]!, saved = store.getNativeConfiguration(original);
      const frozen = web.webStore.getTask(original)?.configuration ?? (saved === null ? null : { ...saved, agentControlMode: original.agentControlMode ?? "herdr", recoveryLimit: workerConfigurationDefaults.recoveryLimit });
      coordinatorConfiguration = { repositories: [], globalConfiguration: frozen, recoveryLimit: frozen?.recoveryLimit ?? workerConfigurationDefaults.recoveryLimit, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    }
    const coordinator = createWorkerCoordinator({
      freezeConfiguration: toolRuntime.freezeConfiguration, store, git, herdr, ...web, remote, serverOrigin: serverUrl, workerId, platform, machine, ...coordinatorConfiguration,
      hasHerdrJournal: await hasHerdrJournal(paths, platform),
      availableDiskBytes: () => { const fs = statfsSync(paths.workerDirectory, { bigint: true }); return fs.bavail * fs.bsize; },
      buildPrompt: buildWorkerPrompt, ...(retryPromptSource === undefined || preparePromptSource === undefined ? {} : { promptSource: retryPromptSource, preparePromptSource }), emit: diagnostics.emit, signal,
    });
    const result = await submitWorkerControl({
      store, remote, serverOrigin: serverUrl, workerId, platform, machine, repositories: coordinatorConfiguration.repositories,
      request: options.request, signal, coordinator, verifyWebServer: web.verifyWebServer,
      emit: diagnostics.emit,
    });
    diagnostics.emit({ kind: "management", ...(result.task === null ? {} : { task: result.task }), message: result.message });
  } catch (error) { failures.push(error); }
  finally {
    controlPromptSource?.close();
    try { await configurationManager?.stop(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
    try { await web?.archiveMaintenance.close(); } catch (error) { failures.push(error); }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { web?.webStore.close(); } catch (error) { failures.push(error); }
    try { actualHerdr?.lifecycle?.close(); } catch (error) { failures.push(error); }
    try { await selectionVerifier.close(); } catch (error) { failures.push(error); }
    try { await tools?.close(); } catch (error) { failures.push(error); }
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await diagnostics?.flush(); } catch (error) { failures.push(error); }
    try { await lock?.release(); } catch (error) { failures.push(error); }
    cancellation.dispose();
  }
  throwFailures(failures);
};

/** Operates only retained resources under the same exclusive runner lock. */
export const runWorkerResources = async (options: {
  homeDirectory: string; request: WorkerResourceCommandRequest; output: (message: string) => void; signal?: AbortSignal;
}): Promise<void> => {
  const paths = resolveWorkerPaths(options.homeDirectory), platform = currentWorkerPlatform();
  if (platform !== "macos") throw new Error("Herdr recording resource management requires macOS stop evidence.");
  const lock = await tryAcquireWorkerInstanceLock(paths);
  if (lock === null) throw new Error("Stop daynight worker run before inspecting or disposing retained resources.");
  let herdr: WorkerHerdrAdapter | undefined, store: ReturnType<typeof openWorkerStore> | undefined, git: ReturnType<typeof createWorkerGitManager> | undefined;
  const operation = createOperation({ ...(options.signal === undefined ? {} : { signal: options.signal }), limits: { totalMs: 300_000 } });
  try {
    if (!await hasHerdrJournal(paths, platform)) {
      if (options.request.kind !== "list") throw new Error("The original Herdr lifecycle journal is missing; disposal is prohibited.");
      options.output("[]\n"); return;
    }
    const { serverUrl, serverToken } = await loadServerConfiguration(paths, operation.signal);
    if (serverToken === undefined) throw new Error("The original Worker credential is unavailable. Run daynight login with its original owner before resource management.");
    const workerId = await ensureWorkerIdentity(paths, operation.signal);
    const remote = createWorkerRemote({ serverUrl, serverToken });
    herdr = createDurableWorkerHerdr({ paths, homeDirectory: options.homeDirectory, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask, currentUserId: remote.currentUserId });
    const archive = herdr.lifecycle?.archive;
    if (!archive) throw new Error("The installed Worker does not support retained Herdr recording resources.");
    if (options.request.kind === "list") { options.output(`${JSON.stringify(archive.resources(), null, 2)}\n`); return; }
    const request = options.request;
    const resource = archive.resources().find(value => value.sessionId === request.sessionId);
    if (!resource) throw new Error("The requested original Session has no retained resource record.");
    if (request.kind === "retry") {
      const result = await archive.retry(request, operation);
      options.output(`${JSON.stringify(result, null, 2)}\n`); return;
    }
    store = openWorkerStore(paths.databaseFile);
    const project = store.getProject(request);
    if (!project || path.join(project.localPath, ".worktrees", "daynight", request.taskId) !== resource.worktreePath) throw new Error("The original worktree path has no matching project binding.");
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory,
      reportPending: pending => options.output(`Git ${pending.command} attempt ${pending.attemptId} local cleanup remains pending for project ${pending.projectId}; waiting for local close.\n`),
      reportSettled: pending => options.output(`Git ${pending.command} attempt ${pending.attemptId} local resources closed for project ${pending.projectId}.\n`),
    });
    const result = await archive.dispose(request, operation, async () => {
      operation.check();
      const fresh = archive.resources().find(value => value.sessionId === request.sessionId);
      if (!fresh) throw new Error("The original resource responsibility disappeared during disposal.");
      // The archive owner first verifies the live claim and persists this exact
      // intent. A local shutdown record alone cannot decide claim finality.
      if (fresh.disposition?.operationId !== request.operationId || fresh.disposition.action !== request.action) throw new Error("The original authorized disposal intent is missing.");
      assertHerdrDisposalTarget(fresh, request);
      await git!.removeWorktree(project, request, operation);
      if (await git!.findWorktree(project, request, operation) !== null) throw new Error("The original worktree remains after explicit deletion.");
    });
    reconcileDeletedHerdrResource(store, result);
    options.output(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    operation.dispose();
    try { await git?.dispose(); } finally {
      try { herdr?.lifecycle?.close(); } finally { try { store?.close(); } finally { await lock.release(); } }
    }
  }
};
