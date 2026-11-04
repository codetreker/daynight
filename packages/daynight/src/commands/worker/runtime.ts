import { uploadStoppedControllerArchive } from "../controller/archive-upload.js";
import { readLaunchTicket, controllerExecutionDirectory } from "../controller/launch-ticket.js";
import { prepareAgentCliAliases } from "../../cli/agent-cli-aliases.js";
import { readAgentCliAliases } from "../../config/agent-cli-aliases.js";
import path from "node:path";
import { maintainWorkerControllerGrants } from "./backends/grant-renewal.js";
import { openWebExecutionStore } from "./backends/web-store.js";
import { createWebExecutionBackend } from "./backends/web.js";
import { createWebControllerLauncher } from "./backends/web-process.js";
import { createWorkerSessionApi } from "./backends/session-api.js";
import type { WorkerEvent } from "./execution.js";
import type { WorkerPaths } from "./paths.js";
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createOperation } from "../../api/operation.js";
import { ApiError } from "../../api/client.js";
import type { WorkerCloudNative, WorkerCloudResource, WorkerCloudValue } from "../../api/worker-configuration.js";
import { parseProviderArguments } from "../controller/providers/projection.js";
import { validateHerdrAgentArguments } from "./herdr/arguments.js";
import { probeNativeAgentVersion } from "./herdr/version-probe.js";
import { createWorkerConfigurationManager } from "./configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationSnapshot } from "./configuration.js";
import { parseWorkerCloudBootstrap, readWorkerLocalConfiguration, resolveCloudNative, workerLocalRepositoryForProject } from "./configuration-source.js";
import type { WorkerProject } from "./types.js";
import type { AgentControlMode, TaskPlatform, WorkerMachine } from "../../api/types.js";
import { validateWorkerConfigurationSource } from "./config.js";
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
import { createWorkerTelemetryCollector } from "./telemetry.js";
import { openWorkerStore } from "./store.js";
import { createWorkerGitManager } from "./worktrees.js";

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

const hasWorkerDatabase = async (file: string): Promise<boolean> => {
  try { await lstat(file); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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

const nativeConfigurationApplication = (options: {
  paths: WorkerPaths; homeDirectory: string; workingDirectory: string; mode: AgentControlMode;
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
      if (options.mode === "web") parseProviderArguments(native.agent, native.args);
      else validateHerdrAgentArguments(native.agent, native.args);
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
    return { webStore, webBackend, launcher, backfillArchives, verifyWebServer: api.verifySupport, verifyWebUnregistered: api.verifyUnregistered, buildPrompt };
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
  const failures: unknown[] = [];
  try {
    signal.throwIfAborted();
    const local = await readWorkerLocalConfiguration(paths, signal);
    const { serverUrl, serverToken } = local;
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    lock = await acquireWorkerInstanceLock(paths);
    const workerId = await ensureWorkerIdentity(paths, signal);
    for (const directory of [paths.temporaryDirectory, paths.logsDirectory]) await mkdir(directory, { recursive: true, mode: 0o700 });
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    const emit = diagnostics.emit;
    const remote = createWorkerRemote({ serverUrl, serverToken });
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
    const getStore = (): ReturnType<typeof openWorkerStore> => store === undefined ? (store = openWorkerStore(paths.databaseFile)) : store;
    const getGit = (): ReturnType<typeof createWorkerGitManager> => git === undefined ? (git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory })) : git;
    const nativeApplication = nativeConfigurationApplication({ paths, homeDirectory: options.homeDirectory, workingDirectory: options.workingDirectory, mode: local.agentControlMode, signal, emit });
    const view = (snapshot: WorkerConfigurationSnapshot): WorkerCoordinatorConfiguration | null => {
      const effective = snapshot.effective;
      if (effective.maxConcurrent === null || effective.recoveryLimit === null) return null;
      const repositories: WorkerRepositoryAssignment[] = [];
      for (const project of effective.projects) {
        const binding = prepared.get(project.projectId);
        if (project.ready && project.native !== null && binding !== undefined) repositories.push({ project: binding, configuration: resolveCloudNative(project.native, local.agentControlMode, effective.recoveryLimit) });
      }
      return { repositories, readyProjectIds: effective.projects.filter(project => project.ready && prepared.has(project.projectId)).map(project => project.projectId), globalConfiguration: effective.native === null ? null : resolveCloudNative(effective.native, local.agentControlMode, effective.recoveryLimit), maxConcurrent: effective.maxConcurrent };
    };
    const transitions = new Map<string, string>();
    let effectiveSignature = "";
    let configurationChanged = new AbortController();
    configuration = await createWorkerConfigurationManager({
      file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal,
      applyNative: nativeApplication.apply,
      onChange: snapshot => {
        const signature = JSON.stringify(snapshot.effective);
        if (signature !== effectiveSignature) { effectiveSignature = signature; configurationChanged.abort(); }
        const current = view(snapshot);
        if (current !== null) coordinator?.updateConfiguration(current);
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
    if (resource.desired === null) bootstrap = await parseWorkerCloudBootstrap(local.source, paths, remote.resolveProject, signal);
    const manager = configuration;
    let reconcileReport = false;
    const telemetry = createWorkerTelemetryCollector({ paths, homeDirectory: options.homeDirectory, version: options.version, workingDirectory: options.workingDirectory, machine, platform });
    reporter = createWorkerReporter({ signal, collect: operation => telemetry.collect(operation), send: (report, operation) => remote.report(workerId, report, operation), emit,
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
          catch (error) { if (!(error instanceof ApiError) || error.outcomeUnconfirmed) reconcileReport = true; throw error; }
        },
        accept: async (sent, receipt) => { await manager.acknowledge(sent, receipt); if (receipt.desired !== null) bootstrap = null; },
      },
    });
    signal.throwIfAborted();
    await manager.configureProjectAdapters({ prepare: async (projectId, applicationSignal) => {
      const project = await remote.project(projectId, applicationSignal);
      const currentStore = getStore();
      const previous = currentStore.getProject({ projectId });
      const mapped = previous === null ? await workerLocalRepositoryForProject(local, paths, project) : undefined;
      if (previous === null && mapped === undefined) return false;
      if (previous !== null) await remote.resolveProject({ repoUrl: previous.repoUrl, projectId }, applicationSignal);
      const binding = previous === null ? currentStore.registerProject({ projectId, repoUrl: mapped!.remote, localPath: mapped!.path }) : previous;
      const operation = createOperation({ signal: applicationSignal });
      try { await getGit().prepareRepository(binding, operation); }
      finally { operation.dispose(); }
      prepared.set(projectId, binding);
    } });
    const lazyHerdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => {
      const environment = nativeApplication.current();
      if (environment === undefined) throw new Error("The native environment has not passed configuration validation.");
      herdr = herdr === undefined ? platform === "macos" ? createDurableWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...environment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask }) : createWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...environment }) : herdr;
      return Reflect.get(herdr, property);
    } });
    let attachmentShown = false, started = false;
    while (!signal.aborted) {
      try {
        const current = view(manager.current());
        if (current !== null) {
          const databaseExists = store !== undefined || await hasWorkerDatabase(paths.databaseFile);
          if (current.repositories.length > 0 || databaseExists) {
            const currentStore = getStore();
            if (coordinator === undefined && (current.repositories.length > 0 || currentStore.listUnfinishedTasks().length > 0)) {
              if (web === undefined) web = await createWebRuntime(options, paths, currentStore, getGit(), serverUrl, serverToken, platform, emit);
              if (renewal === undefined) renewal = maintainWorkerControllerGrants({ homeDirectory: options.homeDirectory, serverOrigin: serverUrl, store: web.webStore, launcher: web.launcher, signal,
                onError: message => emit({ kind: "credential-renewal-error", message }),
              }).catch(error => { failures.push(error); cancellation.controller.abort(error); });
              coordinator = createWorkerCoordinator({ store: currentStore, git: getGit(), herdr: lazyHerdr, ...web, remote, serverOrigin: serverUrl, workerId, platform, machine, ...current,
                hasHerdrJournal: await hasHerdrJournal(paths, platform), onInventory: reporter.publishInventory, onClaim: reporter.recordClaim,
                buildPrompt: web.buildPrompt, emit, signal });
            }
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
      const interval = manager.current().effective.pollIntervalMs;
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
    await renewal;
    try { await reporter?.stop(); } catch (error) { failures.push(error); }
    try { await configuration?.stop(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
    if (coordinator !== undefined) {
      try {
        diagnostics?.emit({ kind: "shutdown", message: "Stopping agents while retaining unfinished claims, worktrees and native session IDs." });
        if (!await coordinator.shutdown()) throw new Error("Some task resources could not be confirmed stopped and closed; the private Herdr instance was retained.");
        const operation = createOperation({ limits: { totalMs: 30_000 } });
        try { if (herdr !== undefined && herdr.lifecycle === undefined) await herdr.stopInstance(operation); }
        finally { operation.dispose(); }
      } catch (error) { failures.push(error); }
    }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { web?.webStore.close(); } catch (error) { failures.push(error); }
    try { herdr?.lifecycle?.close(); } catch (error) { failures.push(error); }
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
    const nativeApplication = nativeConfigurationApplication({ paths, homeDirectory: options.homeDirectory, workingDirectory: options.homeDirectory, mode: local.agentControlMode, signal, emit: diagnostics.emit });
    let coordinatorConfiguration: WorkerCoordinatorConfiguration = { repositories: [], globalConfiguration: null, maxConcurrent: 1 };
    const sources = store.listTasks().filter(task => task.taskId === options.request.taskId && task.claimId === options.request.claimId && (options.request.projectId === undefined || task.projectId === options.request.projectId));
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
        for (const repository of initial.repositories) {
          const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, signal);
          const binding = store.registerProject({ projectId: project.id, repoUrl: repository.remote, localPath: repository.path });
          repositories.push({ project: binding, configuration: repository });
        }
        coordinatorConfiguration = { repositories, globalConfiguration: initial, maxConcurrent: initial.maxConcurrent };
      } else {
        configurationManager = await createWorkerConfigurationManager({ file: paths.configurationFile, identity: { serverOrigin: serverUrl, userId, workerId }, signal, applyNative: nativeApplication.apply });
        await configurationManager.receive(resource.desired, resource.observationRevision);
        await configurationManager.settle();
        const effective = configurationManager.current().effective;
        if (effective.maxConcurrent === null || effective.recoveryLimit === null) throw new Error("The Worker's cloud runtime parameters are unavailable.");
        const globalConfiguration = effective.native === null ? null : resolveCloudNative(effective.native, local.agentControlMode, effective.recoveryLimit);
        const repositories = store.listProjects().flatMap(project => {
          const selected = effective.projects.find(value => value.projectId === project.projectId);
          const native = selected === undefined ? effective.native : selected.native;
          return native === null ? [] : [{ project, configuration: resolveCloudNative(native, local.agentControlMode, effective.recoveryLimit!) }];
        });
        coordinatorConfiguration = { repositories, readyProjectIds: store.listProjects().map(project => project.projectId), globalConfiguration, maxConcurrent: effective.maxConcurrent };
      }
    }
    const agentEnvironment = options.request.kind === "retry" ? nativeApplication.current() === undefined ? await prepareWorkerAgentEnvironment(paths, diagnostics.emit, signal) : nativeApplication.current()! : {};
    const herdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => { actualHerdr ??= platform === "macos" ? createDurableWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...agentEnvironment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask }) : createWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...agentEnvironment }); return Reflect.get(actualHerdr, property); } });
    web = await createWebRuntime(options, paths, store, git, serverUrl, serverToken, platform, diagnostics.emit);
    if (frozenRetry) coordinatorConfiguration = { repositories: [], globalConfiguration: web.webStore.getTask(sources[0]!)?.configuration ?? null, maxConcurrent: 1 };
    const machine = machineDescription(platform);
    const coordinator = createWorkerCoordinator({
      store, git, herdr, ...web, remote, serverOrigin: serverUrl, workerId, platform, machine, ...coordinatorConfiguration,
      hasHerdrJournal: await hasHerdrJournal(paths, platform),
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
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await diagnostics?.flush(); } catch (error) { failures.push(error); }
    try { await lock?.release(); } catch (error) { failures.push(error); }
    cancellation.dispose();
  }
  throwFailures(failures);
};
