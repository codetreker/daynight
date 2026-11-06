import { uploadStoppedControllerArchive } from "../controller/archive-upload.js";
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
import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import type { WorkerResourceCommandRequest } from "./resource-disposal.js";
import { assertHerdrDisposalTarget, reconcileDeletedHerdrResource } from "./resource-disposal.js";
import { lstat, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createOperation } from "../../api/operation.js";
import { repositoryLocation, resolveRepositoryRoot } from "../../repository/location.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { ApiError } from "../../api/client.js";
import { ProtocolError } from "../../api/parse.js";
import type { WorkerCloudNative, WorkerCloudResource, WorkerCloudValue } from "../../api/worker-configuration.js";
import { probeNativeAgentVersion } from "./herdr/version-probe.js";
import { createWorkerConfigurationManager } from "./configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationSnapshot } from "./configuration.js";
import { parseWorkerCloudBootstrap, readWorkerLocalConfiguration, resolveCloudNative, workerLocalExplicitProjectIds, workerLocalRepositoryForId, workerLocalRepositoryForProject, workerLocalUnboundRepository, workerLocalUnboundRepositoryIndexes } from "./configuration-source.js";
import type { WorkerProject } from "./types.js";
import type { AgentControlMode, TaskPlatform, WorkerMachine } from "../../api/types.js";
import { validateWorkerConfigurationSource, validateWorkerRepositoryLocations } from "./config.js";
import { createWorkerCoordinator } from "./coordinator.js";
import type { WorkerCoordinatorConfiguration, WorkerRepositoryAssignment } from "./coordinator.js";
import { submitWorkerControl } from "./control.js";
import type { WorkerControlRequest } from "./control.js";
import { createWorkerDiagnostics, workerSqliteMigrationEvent } from "./diagnostics.js";
import { isWorkerCancellation } from "./execution.js";
import { createWorkerHerdr } from "./herdr.js";
import type { WorkerHerdrAdapter } from "./herdr.js";
import { createDurableWorkerHerdr } from "./herdr/durable.js";
import { ensureWorkerIdentity } from "./identity.js";
import { acquireWorkerInstanceLock, tryAcquireWorkerInstanceLock } from "./instance-lock.js";
import { resolveWorkerPaths } from "./paths.js";
import { createWorkerPromptBuilder } from "./prompts.js";
import { createWorkerRemote } from "./remote.js";
import { createWorkerReporter } from "./reporter.js";
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
import { createWorkerGitManager } from "./worktrees.js";
import { normalizeWorkerNative, workerRuntimeConfigurationReport } from "./native-overrides.js";
import type { WorkerLocalNativeOverrides } from "./local-native.js";
import { createNativeSelectionVerifier } from "./native-selection.js";

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
  paths: WorkerPaths; homeDirectory: string; workingDirectory: string; mode: AgentControlMode;
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
    apply: async (native: WorkerCloudNative, signal: AbortSignal): Promise<void> => {
      normalizeWorkerNative(native, options.mode, options.overrides);
      const nativeEnvironment = await getEnvironment();
      const operation = createOperation({ signal, limits: { totalMs: 15_000, requestMs: 10_000 } });
      try { await probeNativeAgentVersion({ agent: native.agent, environment: { ...process.env, ...nativeEnvironment.agentEnvironment }, cwd: options.workingDirectory }, operation); }
      finally { operation.dispose(); }
    },
  };
};

const createWebRuntime = async (options: { homeDirectory: string; packageDirectory: string }, paths: WorkerPaths, store: ReturnType<typeof openWorkerStore>, git: ReturnType<typeof createWorkerGitManager>, serverUrl: string, serverToken: string, platform: TaskPlatform, emit: (event: WorkerEvent) => void) => {
  const webStore = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite"), { onMigration: event => { emit(workerSqliteMigrationEvent(event)); } });
  try {
    const buildPrompt = await createWorkerPromptBuilder(options.packageDirectory);
    const api = createWorkerSessionApi(serverUrl, serverToken);
    const launcher = createWebControllerLauncher({ ...options, store: webStore, sessionApi: api, now: Date.now });
    const archive: NonNullable<import("./backends/web.js").WebBackendOptions["archive"]> = async (task, journalPath, signal) => {
      if (!task.webExecution) throw new Error("Original controller execution is missing.");
      const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution.launchId);
      if (ticket.serverOrigin !== serverUrl || task.serverOrigin !== serverUrl) throw new Error("Archive server identity changed.");
      await uploadStoppedControllerArchive({ journalPath, ticket, serverToken, signal });
    };
    const backfilled = new Set<string>();
    const archiveRetryAt = new Map<string, number>();
    let lastArchiveAttempt: string | null = null;
    const backfillArchives = async (signal: AbortSignal) => {
      const tasks = webStore.listCompletedTasks();
      const previous = tasks.findIndex(task => task.webExecution?.executionId === lastArchiveAttempt);
      for (let offset = 1; offset <= tasks.length; offset++) {
        if (signal.aborted) return;
        const task = tasks[(previous + offset) % tasks.length]!;
        const execution = task.webExecution;
        if (!execution || execution.launchSubmission === "not-submitted" || task.serverOrigin !== serverUrl || backfilled.has(execution.executionId) || (archiveRetryAt.get(execution.executionId) ?? 0) > Date.now()) continue;
        // Advance on failure as well as success so a damaged source cannot monopolize catch-up.
        lastArchiveAttempt = execution.executionId;
        try {
          await archive(task, path.join(controllerExecutionDirectory(options.homeDirectory, execution.executionId), "journal.sqlite"), signal);
          backfilled.add(execution.executionId);
          emit({ kind: "session-archive-ready", message: `Completed session ${execution.sessionId} history is archived.` });
        } catch { archiveRetryAt.set(execution.executionId, Date.now() + 60_000); emit({ kind: "session-archive-retry", message: `Completed session ${execution.sessionId} archive is pending; its source is retained for retry.` }); }
        // Bound historical catch-up per reconciliation round.
        break;
      }
    };
    const webBackend = createWebExecutionBackend({ homeDirectory: options.homeDirectory, store: webStore, git, launcher, platform, now: Date.now, archive,
      buildPrompt: (task, actualPlatform) => {
        if (task.configuration === null || task.resources.worktree === null) throw new Error("The frozen Web assignment is incomplete.");
        return buildPrompt({ ...task, agent: task.configuration.agent, agentControlMode: "web", sessionId: task.resources.nativeSession?.sessionId ?? null, configuration: task.configuration, worktree: task.resources.worktree }, actualPlatform);
      },
      emit: event => { const task = event.task === undefined ? null : store.getTask(event.task); emit({ kind: event.kind, message: event.message, ...(task === null ? {} : { task }) }); },
    });
    return { webStore, webBackend, launcher, backfillArchives, verifyWebServer: api.verifySupport, verifyWebUnregistered: api.verifyUnregistered, verifyWebStartupReporting: api.supportsStartupReports, buildPrompt };
  } catch (error) {
    try { webStore.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Web runtime initialization and store shutdown failed."); }
    throw error;
  }
};

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
  let git: ReturnType<typeof createWorkerGitManager> | undefined;
  let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
  let herdr: WorkerHerdrAdapter | undefined;
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnostics>> | undefined;
  let configuration: WorkerConfigurationManager | undefined;
  let renewal: Promise<void> | undefined;
  let reporter: ReturnType<typeof createWorkerReporter> | undefined;
  let bots: WorkerBotHost | undefined;
  let botRun: Promise<void> | undefined;
  let readOnly: ReturnType<typeof createWorkerReadOnlyChannel> | undefined;
  let modelDiscovery: ReturnType<typeof createWorkerModelDiscovery> | undefined;
  let initialRemovalReconciliation: Promise<void> | undefined;
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
    const readCloudConfiguration = async (readSignal: AbortSignal): Promise<WorkerCloudResource> => {
      try { return await remote.configuration(workerId, readSignal); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) throw error;
        return { desired: null, observationRevision: "0", observation: null };
      }
    };
    const resource = await readCloudConfiguration(signal);
    const machine = machineDescription(platform);
    const prepared = new Map<string, WorkerProject>();
    const locallyKnownIds = new Set(workerLocalExplicitProjectIds(local, paths));
    const unboundMappings = new Map<string, number>(workerLocalUnboundRepositoryIndexes(local, paths).map(index => [`legacy:${index}`, index]));
    // Local mappings can retain Git-only owners even after cloud selection changes.
    const unobservedLocalMappings = new Set([...locallyKnownIds, ...unboundMappings.keys()]);
    const confirmedNoLocalMapping = new Set<string>();
    const getStore = (): ReturnType<typeof openWorkerStore> => store === undefined ? (store = openWorkerStore(paths.databaseFile)) : store;
    const getGit = (): ReturnType<typeof createWorkerGitManager> => git === undefined ? (git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory })) : git;
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
    const nativeApplication = nativeConfigurationApplication({ paths, homeDirectory: options.homeDirectory, workingDirectory: options.workingDirectory, mode: local.agentControlMode, overrides: local, signal, emit });
    let fallback: Awaited<ReturnType<typeof validateWorkerConfigurationSource>> | null = null;
    let fallbackRepositories: WorkerRepositoryAssignment[] = [];
    let fallbackTargets: string[] = [];
    let fallbackComplete = true;
    const discovered = new Map<string, string>();
    const view = (snapshot: WorkerConfigurationSnapshot): WorkerCoordinatorConfiguration | null => {
      if (snapshot.desired === null && fallback !== null) return {
        repositories: fallbackRepositories, targetProjectIds: fallbackTargets,
        readyProjectIds: fallbackRepositories.map(repository => repository.project.projectId),
        globalConfiguration: fallback, maxConcurrent: fallback.maxConcurrent,
      };
      const effective = snapshot.effective;
      if (effective.maxConcurrent === null || effective.recoveryLimit === null) return null;
      const repositories: WorkerRepositoryAssignment[] = [];
      for (const project of effective.projects) {
        const binding = prepared.get(project.projectId);
        if (project.ready && project.native !== null && binding !== undefined) repositories.push({ project: binding, configuration: effectiveExecutionConfiguration(project.native, local.agentControlMode, effective.recoveryLimit, local) });
      }
      return { repositories, targetProjectIds: snapshot.desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: effective.projects.filter(project => project.ready && prepared.has(project.projectId)).map(project => project.projectId), globalConfiguration: effective.native === null ? null : effectiveExecutionConfiguration(effective.native, local.agentControlMode, effective.recoveryLimit, local), maxConcurrent: effective.maxConcurrent };
    };
    const transitions = new Map<string, string>();
    let effectiveSignature = "";
    let configurationChanged = new AbortController();
    let scheduleInitialRemovals: (() => void) | undefined;
    configuration = await createWorkerConfigurationManager({
      file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal,
      applyNative: nativeApplication.apply,
      onChange: snapshot => {
        for (const project of snapshot.desired?.value.projects ?? []) {
          if (getStore().getProject({ projectId: project.projectId }) === null && !confirmedNoLocalMapping.has(project.projectId)) unobservedLocalMappings.add(project.projectId);
        }
        const signature = JSON.stringify(snapshot.effective);
        if (signature !== effectiveSignature) { effectiveSignature = signature; reporter?.publishInventory(null); configurationChanged.abort(); }
        const current = view(snapshot);
        coordinator?.updateConfiguration(current ?? { repositories: [], targetProjectIds: snapshot.desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: snapshot.effective.maxConcurrent ?? 1 });
        scheduleInitialRemovals?.();
        for (const item of snapshot.items) {
          const key = JSON.stringify(item.key), state = JSON.stringify([item.targetRevision, item.state, item.error]);
          if (transitions.get(key) === state) continue;
          transitions.set(key, state);
          emit({ kind: "worker-configuration", message: JSON.stringify({ desiredRevision: snapshot.desired?.revision, key: item.key, targetRevision: item.targetRevision, state: item.state, error: item.error }) });
        }
      },
      onError: error => { failures.push(error); cancellation.controller.abort(error); },
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
    modelDiscovery = createWorkerModelDiscovery({
      defaultCwd: options.workingDirectory, environment: process.env, verifier: selectionVerifier,
      configuration: () => {
        const native = manager.current().effective.native;
        if (native === null) throw new WorkerModelDiscoveryError("capability_error");
        return normalizeWorkerNative(native, "web", local, false);
      },
    });
    const executeReadOnly = async <K extends WorkerReadOnlyOperation>(operation: K, input: WorkerReadOnlyOperations[K]["input"], requestSignal: AbortSignal): Promise<WorkerReadOnlyOperations[K]["result"]> => {
      const result = operation === "directory.list"
        ? await browseWorkerDirectory(input as WorkerDirectoryInput, { defaultCwd: options.workingDirectory, signal: requestSignal })
        : await modelDiscovery!.discover(input as WorkerModelInput, requestSignal);
      return result as WorkerReadOnlyOperations[K]["result"];
    };
    readOnly = createWorkerReadOnlyChannel({ serverOrigin: serverUrl, serverToken, ownerUserId: userId, workerId,
      configurationSignature: () => JSON.stringify([manager.current().effective, local.agentModel, local.agentReasoningEffort]),
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
                const worktrees = await getGit().listWorktrees({ projectId: project.id, repoUrl: mapping.remote, localPath: mapping.path }, operation, false, true);
                if (worktrees.some(({ owner }) => owner.projectId !== project.id)) throw new Error("An unbound local repository contains resources owned by another Project.");
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
        if (projectId !== undefined) targets.add(projectId);
        try {
          if (projectId !== undefined && getStore().getProject({ projectId }) === null) {
            await admitLocalBinding({ projectId, repoUrl: repository.remote, localPath: repository.path }, signal);
          }
          resolving = true;
          const project = await resolveProject({ repoUrl: repository.remote, ...(projectId === undefined ? {} : { projectId }) }, signal);
          resolving = false;
          projectId = project.id;
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
              await nativeApplication.apply({ agent: repository.agent, model: repository.model, args: repository.args }, signal);
              prepared.set(projectId, await admitRepository(binding, signal));
            } finally { reservations.delete(projectId); }
          }
          repositories.push({ project: prepared.get(projectId)!, configuration: repository });
        } catch (error) {
          if (signal.aborted || error instanceof ProtocolError || error instanceof ApiError && !projectUnavailable(error) || resolving && !projectUnavailable(error)) {
            reporter?.publishInventory(null);
            throw error;
          }
          if (projectUnavailable(error)) allAccessible = false;
          if (projectId === undefined) allIdentified = false;
          emit({ kind: "warning", message: `Worker repository ${projectId ?? repository.remote} could not be prepared.`, error });
        }
      }
      fallbackTargets = [...targets];
      fallbackRepositories = repositories;
      fallbackComplete = allIdentified;
      if (allAccessible && allIdentified) {
        try { bootstrap = await parseWorkerCloudBootstrap(local.source, paths, resolveProject, signal); }
        catch (error) { if (signal.aborted || !projectUnavailable(error)) throw error; emit({ kind: "warning", message: "Worker configuration bootstrap could not be verified.", error }); }
      }
    };
    let initialRemovalsComplete = false;
    let initialRemovalsJob: Promise<void> | undefined;
    const ensureInitialRemovals = (): Promise<void> => {
      if (initialRemovalsComplete || manager.current().desired === null) return Promise.resolve();
      if (initialRemovalsJob !== undefined) return initialRemovalsJob;
      const job = (async () => {
        for (const project of getStore().listProjects()) {
          signal.throwIfAborted();
          await manager.ensureProjectRemoval(project.projectId);
        }
        initialRemovalsComplete = true;
      })();
      initialRemovalsJob = job;
      initialRemovalReconciliation = job;
      void job.finally(() => { if (initialRemovalsJob === job) initialRemovalsJob = undefined; }).catch(() => undefined);
      return job;
    };
    bots = createWorkerBotHost({ ...options, paths, owner: { serverOrigin: serverUrl, ownerUserId: userId, workerId }, serverToken, emit,
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
    const telemetry = createWorkerTelemetryCollector({ paths, homeDirectory: options.homeDirectory, version: options.version, workingDirectory: options.workingDirectory, machine, platform, workerId, serverOrigin: serverUrl, assistantHost: bots });
    reporter = createWorkerReporter({ signal, collect: async operation => {
      const sample = await telemetry.collect(operation);
      const snapshot = manager.current();
      const localFallback = snapshot.desired === null && fallback !== null;
      const effective = localFallback ? {
        native: fallback,
        projects: fallbackRepositories.map(repository => ({ projectId: repository.project.projectId, native: repository.configuration })),
      } : snapshot.effective;
      const runtimeConfiguration = workerRuntimeConfigurationReport(effective, local.agentControlMode, local, localFallback ? "local" : "cloud");
      return { ...sample, telemetry: { ...sample.telemetry, ...(runtimeConfiguration === undefined ? {} : { runtimeConfiguration }) } };
    }, send: (report, operation) => remote.report(workerId, report, operation), emit,
      configuration: {
        prepare: async operation => {
          if (!reconcileReport) return;
          const actual = await readCloudConfiguration(operation.signal);
          await manager.receive(actual.desired, actual.observationRevision);
          if (actual.desired !== null) bootstrap = null;
          reconcileReport = false;
        },
        capture: () => manager.report(manager.current().desired === null ? bootstrap : null),
        send: async (report, captured, operation) => {
          try { return await remote.reportConfiguration(workerId, report, captured, operation); }
          catch (error) {
            if (!(error instanceof ApiError) || error.outcomeUnconfirmed) reconcileReport = true;
            if (error instanceof ApiError && error.status === 404 && error.code === "not_found" && manager.current().desired === null && captured.bootstrap !== null) {
              bootstrap = null;
              fallback ??= await validateWorkerConfigurationSource(local.source === undefined ? "{}" : local.source, paths, operation.signal);
            }
            throw error;
          }
        },
        accept: async (sent, receipt) => { await manager.acknowledge(sent, receipt); if (receipt.desired !== null) bootstrap = null; },
      },
    });
    scheduleInitialRemovals = () => { if (!signal.aborted) void ensureInitialRemovals().catch(error => { if (!signal.aborted) emit({ kind: "reconciliation-error", message: "Retained project removal reconciliation failed; configuration reporting remains active.", error }); }); };
    scheduleInitialRemovals();
    signal.throwIfAborted();
    const lazyHerdr = (environment: Awaited<ReturnType<typeof prepareWorkerAgentEnvironment>>): WorkerHerdrAdapter => new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => {
      herdr = herdr === undefined ? platform === "macos" ? createDurableWorkerHerdr({ paths, selectionVerifier, homeDirectory: options.homeDirectory, ...environment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask, currentUserId: remote.currentUserId }) : createWorkerHerdr({ paths, selectionVerifier, homeDirectory: options.homeDirectory, ...environment }) : herdr;
      return Reflect.get(herdr, property);
    } });
    let coordinatorJob: Promise<ReturnType<typeof createWorkerCoordinator>> | undefined;
    const ensureCoordinator = (): Promise<ReturnType<typeof createWorkerCoordinator>> => {
      if (coordinator !== undefined) return Promise.resolve(coordinator);
      if (coordinatorJob !== undefined) return coordinatorJob;
      const job = (async () => {
        const currentStore = getStore();
        if (web === undefined) web = await createWebRuntime(options, paths, currentStore, getGit(), serverUrl, serverToken, platform, emit);
        if (renewal === undefined) renewal = maintainWorkerControllerGrants({ homeDirectory: options.homeDirectory, serverOrigin: serverUrl, store: web.webStore, launcher: web.launcher, signal,
          onError: message => emit({ kind: "credential-renewal-error", message }),
        }).catch(error => { failures.push(error); cancellation.controller.abort(error); });
        const environment = await nativeApplication.prepareEnvironment();
        signal.throwIfAborted();
        const current = view(manager.current()) ?? { repositories: [], targetProjectIds: manager.current().desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: 1 };
        coordinator = createWorkerCoordinator({ store: currentStore, git: getGit(), herdr: lazyHerdr(environment), ...web, remote, serverOrigin: serverUrl, workerId, platform, machine, ...current,
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
          buildPrompt: web.buildPrompt, emit, signal });
        const latest = view(manager.current());
        coordinator.updateConfiguration(latest ?? { repositories: [], targetProjectIds: manager.current().desired?.value.projects.map(project => project.projectId) ?? [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: manager.current().effective.maxConcurrent ?? 1 });
        return coordinator;
      })();
      coordinatorJob = job;
      void job.finally(() => { if (coordinatorJob === job) coordinatorJob = undefined; }).catch(() => undefined);
      return job;
    };
    await manager.configureProjectAdapters({ prepare: async (projectId, applicationSignal) => {
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
    }, remove: async (projectId, applicationSignal) => {
      const runningCoordinator = await ensureCoordinator();
      applicationSignal.throwIfAborted();
      const latest = view(manager.current());
      if (latest !== null) runningCoordinator.updateConfiguration(latest);
      await runningCoordinator.stopProject(projectId, applicationSignal);
      prepared.delete(projectId);
    } });
    let attachmentShown = false, started = false;
    while (!signal.aborted) {
      try {
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
              await web!.backfillArchives(signal);
            }
          }
        }
        if (!started) { emit({ kind: "started", message: `Foreground worker ${workerId} on ${platform}; cloud-managed configuration; logs=${diagnostics.filename}.` }); started = true; }
        if (!attachmentShown && herdr !== undefined) { emit({ kind: "attach", message: "Run daynight worker attach in another terminal for native input." }); attachmentShown = true; }
      } catch (error) {
        if (isWorkerCancellation(error, signal)) break;
        if (signal.aborted) throw error;
        emit({ kind: "reconciliation-error", message: "The reconciliation round failed; configuration reporting remains active and resources remain for the next successful observation.", error });
      }
      await diagnostics.flush();
      if (signal.aborted) break;
      const interval = manager.current().effective.pollIntervalMs ?? (manager.current().desired === null ? fallback?.pollIntervalMs ?? null : null);
      const changed = configurationChanged;
      try {
        if (!changed.signal.aborted) await delay(interval === null ? 1_000 : interval, undefined, { signal: AbortSignal.any([signal, changed.signal]) });
      } catch (error) { if (!changed.signal.aborted && !isWorkerCancellation(error, signal)) throw error; }
      finally { if (configurationChanged === changed) configurationChanged = new AbortController(); }
    }
  } catch (error) {
    if (!isWorkerCancellation(error, signal)) failures.push(error);
  } finally {
    if (!signal.aborted) cancellation.controller.abort(new Error("Worker runtime is closing."));
    readOnly?.close();
    modelDiscovery?.close();
    await Promise.allSettled([...localMappingJobs.values()]);
    await renewal;
    try { await reporter?.stop(); } catch (error) { failures.push(error); }
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
    try { bots?.close(); } catch (error) { failures.push(error); }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { web?.webStore.close(); } catch (error) { failures.push(error); }
    try { herdr?.lifecycle?.close(); } catch (error) { failures.push(error); }
    try { await selectionVerifier.close(); } catch (error) { failures.push(error); }
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await diagnostics?.flush(); } catch (error) { failures.push(error); }
    try { await lock?.release(); } catch (error) { failures.push(error); }
    cancellation.dispose();
  }
  throwFailures(failures);
};

export const runWorkerControl = async (options: {
  homeDirectory: string; packageDirectory: string; request: WorkerControlRequest;
  log?: (message: string) => void; signal?: AbortSignal;
}): Promise<void> => {
  const platform = currentWorkerPlatform();
  const paths = resolveWorkerPaths(options.homeDirectory);
  const cancellation = runtimeCancellation(options.signal);
  const signal = cancellation.controller.signal;
  let lock: Awaited<ReturnType<typeof tryAcquireWorkerInstanceLock>> | undefined;
  let store: ReturnType<typeof openWorkerStore> | undefined;
  let web: Awaited<ReturnType<typeof createWebRuntime>> | undefined;
  let git: ReturnType<typeof createWorkerGitManager> | undefined;
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnostics>> | undefined;
  let actualHerdr: WorkerHerdrAdapter | undefined;
  let configurationManager: WorkerConfigurationManager | undefined;
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
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory });
    const nativeApplication = nativeConfigurationApplication({ paths, homeDirectory: options.homeDirectory, workingDirectory: options.homeDirectory, mode: local.agentControlMode, overrides: local, signal, emit: diagnostics.emit });
    let coordinatorConfiguration: WorkerCoordinatorConfiguration = { repositories: [], globalConfiguration: null, maxConcurrent: 1 };
    const sources = store.listTasks().filter(task => task.taskId === options.request.taskId && task.claimId === options.request.claimId && (options.request.projectId === undefined || task.projectId === options.request.projectId));
    if (sources.length > 1) throw new Error("The source claim is ambiguous; supply --project.");
    const targetProjectId = sources[0]?.projectId ?? options.request.projectId;
    const frozenRetry = options.request.kind === "retry" && sources.length === 1 && sources[0]!.agentControlMode === "web";
    if (options.request.kind !== "release" && !frozenRetry) {
      let resource: WorkerCloudResource;
      try { resource = await remote.configuration(workerId, signal); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found")) throw error;
        resource = { desired: null, observationRevision: "0", observation: null };
      }
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
        coordinatorConfiguration = { repositories, globalConfiguration: initial, maxConcurrent: initial.maxConcurrent };
      } else {
        configurationManager = await createWorkerConfigurationManager({ file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal, applyNative: nativeApplication.apply });
        await configurationManager.receive(resource.desired, resource.observationRevision);
        await configurationManager.settle();
        const effective = configurationManager.current().effective;
        if (effective.maxConcurrent === null || effective.recoveryLimit === null) throw new Error("The Worker's cloud runtime parameters are unavailable.");
        const globalConfiguration = effective.native === null ? null : effectiveExecutionConfiguration(effective.native, local.agentControlMode, effective.recoveryLimit, local);
        const repositories = store.listProjects().flatMap(project => {
          const selected = effective.projects.find(value => value.projectId === project.projectId);
          const native = selected === undefined ? effective.native : selected.native;
          return native === null ? [] : [{ project, configuration: effectiveExecutionConfiguration(native, local.agentControlMode, effective.recoveryLimit!, local) }];
        });
        coordinatorConfiguration = { repositories, readyProjectIds: store.listProjects().map(project => project.projectId), globalConfiguration, maxConcurrent: effective.maxConcurrent };
      }
    }
    const agentEnvironment = options.request.kind === "retry" ? nativeApplication.current() === undefined ? await prepareWorkerAgentEnvironment(paths, diagnostics.emit, signal) : nativeApplication.current()! : {};
    const herdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => { actualHerdr ??= platform === "macos" ? createDurableWorkerHerdr({ paths, selectionVerifier, homeDirectory: options.homeDirectory, ...agentEnvironment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask, currentUserId: remote.currentUserId }) : createWorkerHerdr({ paths, selectionVerifier, homeDirectory: options.homeDirectory, ...agentEnvironment }); return Reflect.get(actualHerdr, property); } });
    web = await createWebRuntime(options, paths, store, git, serverUrl, serverToken, platform, diagnostics.emit);
    if (frozenRetry) coordinatorConfiguration = { repositories: [], globalConfiguration: web.webStore.getTask(sources[0]!)?.configuration ?? null, maxConcurrent: 1 };
    const machine = machineDescription(platform);
    const coordinator = createWorkerCoordinator({
      store, git, herdr, ...web, remote, serverOrigin: serverUrl, workerId, platform, machine, ...coordinatorConfiguration,
      hasHerdrJournal: await hasHerdrJournal(paths, platform),
      availableDiskBytes: () => { const fs = statfsSync(paths.workerDirectory, { bigint: true }); return fs.bavail * fs.bsize; },
      buildPrompt: await createWorkerPromptBuilder(options.packageDirectory), emit: diagnostics.emit, signal,
    });
    const result = await submitWorkerControl({
      store, remote, serverOrigin: serverUrl, workerId, platform, machine, repositories: coordinatorConfiguration.repositories,
      request: options.request, signal, coordinator, verifyWebServer: web.verifyWebServer,
      emit: diagnostics.emit,
    });
    diagnostics.emit({ kind: "management", ...(result.task === null ? {} : { task: result.task }), message: result.message });
  } catch (error) { failures.push(error); }
  finally {
    try { await configurationManager?.stop(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { web?.webStore.close(); } catch (error) { failures.push(error); }
    try { actualHerdr?.lifecycle?.close(); } catch (error) { failures.push(error); }
    try { await selectionVerifier.close(); } catch (error) { failures.push(error); }
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
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory });
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
