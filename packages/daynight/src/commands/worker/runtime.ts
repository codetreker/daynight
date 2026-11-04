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
import { statfsSync } from "node:fs";
import type { WorkerResourceCommandRequest } from "./resource-disposal.js";
import { assertHerdrDisposalTarget, reconcileDeletedHerdrResource } from "./resource-disposal.js";
import { lstat, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createOperation } from "../../api/operation.js";
import type { TaskPlatform, WorkerMachine } from "../../api/types.js";
import { loadServerConfiguration } from "../../config/server.js";
import { readWorkerConfiguration, readWorkerConfigurationSnapshot } from "./config.js";
import { createWorkerCoordinator } from "./coordinator.js";
import type { WorkerRepositoryAssignment } from "./coordinator.js";
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
  prepareRepositories?: (signal: AbortSignal) => Promise<void>;
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
  const failures: unknown[] = [];
  let renewal: Promise<void> | undefined;
  let reporter: ReturnType<typeof createWorkerReporter> | undefined;
  try {
    signal.throwIfAborted();
    let configuration = await readWorkerConfiguration(paths, signal);
    const { serverUrl, serverToken } = await loadServerConfiguration(paths, signal);
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    const prepareRepositories = async (): Promise<void> => {
      if (configuration.repositories.length > 0 || options.prepareRepositories === undefined) return;
      await options.prepareRepositories(signal);
      signal.throwIfAborted();
      const current = await readWorkerConfigurationSnapshot(paths, signal);
      if (current.serverUrl !== serverUrl || current.serverToken !== serverToken) throw new Error("The Daynight service or authentication changed during worker repository configuration; restart the worker with the current configuration.");
      configuration = current.configuration;
      if (configuration.repositories.length === 0) throw new Error("Worker repository configuration did not select any repositories.");
    };
    if (configuration.repositories.length === 0 && options.prepareRepositories !== undefined && !await hasWorkerDatabase(paths.databaseFile)) await prepareRepositories();
    lock = await acquireWorkerInstanceLock(paths);
    signal.throwIfAborted();
    const workerId = await ensureWorkerIdentity(paths, signal);
    store = openWorkerStore(paths.databaseFile);
    await prepareRepositories();
    for (const directory of [paths.temporaryDirectory, paths.logsDirectory]) await mkdir(directory, { recursive: true, mode: 0o700 });
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    const remote = createWorkerRemote({ serverUrl, serverToken });
    await remote.currentUserId(signal);
    const machine = machineDescription(platform);
    const telemetry = createWorkerTelemetryCollector({ paths, homeDirectory: options.homeDirectory, version: options.version, workingDirectory: options.workingDirectory, machine, platform, workerId, serverOrigin: serverUrl });
    reporter = createWorkerReporter({ signal, collect: operation => telemetry.collect(operation), send: (report, operation) => remote.report(workerId, report, operation), emit: diagnostics.emit });
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory });
    const agentEnvironment = await prepareWorkerAgentEnvironment(paths, diagnostics.emit, signal);
    const lazyHerdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => {
      herdr ??= platform === "macos" ? createDurableWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...agentEnvironment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask, currentUserId: remote.currentUserId }) : createWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...agentEnvironment }); return Reflect.get(herdr, property);
    } });
    web = await createWebRuntime(options, paths, store, git, serverUrl, serverToken, platform, diagnostics.emit);
    renewal = maintainWorkerControllerGrants({ homeDirectory: options.homeDirectory, serverOrigin: serverUrl, store: web.webStore, launcher: web.launcher, signal,
      onError: message => diagnostics?.emit({ kind: "credential-renewal-error", message }),
    }).catch(error => { failures.push(error); cancellation.controller.abort(error); });
    const repositories: WorkerRepositoryAssignment[] = [];
    for (const repository of configuration.repositories) {
      const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, signal);
      const previous = store.getProject({ projectId: project.id });
      if (previous !== null && (previous.repoUrl !== repository.remote || previous.localPath !== repository.path)) {
        const operation = createOperation({ signal });
        try {
          if ((await git.listWorktrees(previous, operation)).length > 0) throw new Error("Owned worktrees prevent changing the project's original repository binding.");
        } finally { operation.dispose(); }
      }
      const binding = store.registerProject({ projectId: project.id, repoUrl: repository.remote, localPath: repository.path });
      const operation = createOperation({ signal });
      try { await git.prepareRepository(binding, operation); }
      finally { operation.dispose(); }
      repositories.push({ project: binding, configuration: { agent: repository.agent, agentControlMode: repository.agentControlMode ?? "herdr", model: repository.model, args: repository.args, recoveryLimit: repository.recoveryLimit } });
    }
    coordinator = createWorkerCoordinator({
      store, git, herdr: lazyHerdr, ...web, remote, serverOrigin: serverUrl, workerId, platform,
      machine, repositories, hasHerdrJournal: await hasHerdrJournal(paths, platform),
      availableDiskBytes: () => { const fs = statfsSync(paths.workerDirectory, { bigint: true }); return fs.bavail * fs.bsize; },
      onInventory: reporter.publishInventory, onClaim: reporter.recordClaim,
      maxConcurrent: configuration.maxConcurrent, globalConfiguration: configuration,
      buildPrompt: await createWorkerPromptBuilder(options.packageDirectory),
      emit: diagnostics.emit, signal,
    });
    diagnostics.emit({ kind: "started", message: `Foreground worker ${workerId} on ${platform}; maxConcurrent=${configuration.maxConcurrent}; pollIntervalMs=${configuration.pollIntervalMs}; logs=${diagnostics.filename}.` });
    let attachmentShown = false;
    while (!signal.aborted) {
      try {
        await coordinator.tick();
        await web.backfillArchives(signal);
        if (!attachmentShown && herdr !== undefined) {
          diagnostics.emit({ kind: "attach", message: "Run daynight worker attach in another terminal for native input." });
          attachmentShown = true;
        }
      } catch (error) {
        if (isWorkerCancellation(error, signal)) break;
        if (signal.aborted) throw error;
        diagnostics.emit({ kind: "reconciliation-error", message: "The reconciliation round failed; resources remain for the next successful observation.", error });
      }
      await diagnostics.flush();
      if (signal.aborted) break;
      try { await delay(configuration.pollIntervalMs, undefined, { signal }); }
      catch (error) { if (!isWorkerCancellation(error, signal)) throw error; }
    }
  } catch (error) {
    if (!isWorkerCancellation(error, signal)) failures.push(error);
  } finally {
    if (!signal.aborted) cancellation.controller.abort(new Error("Worker runtime is closing."));
    await renewal;
    try { await reporter?.stop(); } catch (error) { failures.push(error); }
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
  const failures: unknown[] = [];
  try {
    signal.throwIfAborted();
    lock = await tryAcquireWorkerInstanceLock(paths);
    if (lock === null) throw new Error("Stop daynight worker run before running a worker management command.");
    const configuration = await readWorkerConfiguration(paths, signal);
    const { serverUrl, serverToken } = await loadServerConfiguration(paths, signal);
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    const workerId = await ensureWorkerIdentity(paths, signal);
    store = openWorkerStore(paths.databaseFile);
    const remote = createWorkerRemote({ serverUrl, serverToken });
    await remote.currentUserId(signal);
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    const repositories: WorkerRepositoryAssignment[] = [];
    for (const repository of configuration.repositories) {
      const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, signal);
      const binding = store.registerProject({ projectId: project.id, repoUrl: repository.remote, localPath: repository.path });
      repositories.push({ project: binding, configuration: { agent: repository.agent, agentControlMode: repository.agentControlMode ?? "herdr", model: repository.model, args: repository.args, recoveryLimit: repository.recoveryLimit } });
    }
    await mkdir(paths.temporaryDirectory, { recursive: true, mode: 0o700 });
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory });
    const agentEnvironment = options.request.kind === "retry" ? await prepareWorkerAgentEnvironment(paths, diagnostics.emit, signal) : {};
    const herdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, property) => { actualHerdr ??= platform === "macos" ? createDurableWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...agentEnvironment, serverOrigin: serverUrl, serverToken, workerId, readTask: remote.readTask, currentUserId: remote.currentUserId }) : createWorkerHerdr({ paths, homeDirectory: options.homeDirectory, ...agentEnvironment }); return Reflect.get(actualHerdr, property); } });
    web = await createWebRuntime(options, paths, store, git, serverUrl, serverToken, platform, diagnostics.emit);
    const machine = machineDescription(platform);
    const coordinator = createWorkerCoordinator({
      store, git, herdr, ...web, remote, serverOrigin: serverUrl, workerId, platform, machine, repositories,
      hasHerdrJournal: await hasHerdrJournal(paths, platform),
      availableDiskBytes: () => { const fs = statfsSync(paths.workerDirectory, { bigint: true }); return fs.bavail * fs.bsize; },
      maxConcurrent: configuration.maxConcurrent, globalConfiguration: configuration,
      buildPrompt: await createWorkerPromptBuilder(options.packageDirectory), emit: diagnostics.emit, signal,
    });
    const result = await submitWorkerControl({
      store, remote, serverOrigin: serverUrl, workerId, platform, machine, repositories,
      request: options.request, signal, coordinator, verifyWebServer: web.verifyWebServer,
      emit: diagnostics.emit,
    });
    diagnostics.emit({ kind: "management", ...(result.task === null ? {} : { task: result.task }), message: result.message });
  } catch (error) { failures.push(error); }
  finally {
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
