import { requireImplementedWorkerBackend } from "./backend.js";
import { backendResourcesClosed } from "./types.js";
import { createWorkerSessionApi } from "./backends/session-api.js";
import { createWebControllerLauncher } from "./backends/web-process.js";
import { createWebExecutionBackend } from "./backends/web.js";
import type { WorkerHerdrAdapter } from "./herdr.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createOperation } from "../../api/operation.js";
import type { TaskPlatform, WorkerMachine } from "../../api/types.js";
import { loadServerConfiguration } from "../../config/server.js";
import { readWorkerConfiguration } from "./config.js";
import { createWorkerCoordinator } from "./coordinator.js";
import type { WorkerRepositoryAssignment } from "./coordinator.js";
import { createWorkerControlDriver, submitWorkerControl } from "./control.js";
import type { WorkerControlRequest } from "./control.js";
import { createWorkerDiagnostics } from "./diagnostics.js";
import { isWorkerCancellation } from "./execution.js";
import { createWorkerHerdr } from "./herdr.js";
import { ensureWorkerIdentity } from "./identity.js";
import { acquireWorkerInstanceLock, tryAcquireWorkerInstanceLock } from "./instance-lock.js";
import { resolveWorkerPaths } from "./paths.js";
import { createWorkerPromptBuilder } from "./prompts.js";
import { createWorkerRemote } from "./remote.js";
import { openWorkerStore } from "./store.js";
import { createWorkerGitManager } from "./worktrees.js";

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
  // This is a reported host label, independent of worker identity, not machine authentication.
  const bytes = createHash("sha1").update(`daynight:machine:${platform}:${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return { id: `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`, name };
};

export const runWorker = async (options: {
  homeDirectory: string; packageDirectory: string;
  log?: (message: string) => void; signal?: AbortSignal;
}): Promise<void> => {
  const platform = currentWorkerPlatform();
  const paths = resolveWorkerPaths(options.homeDirectory);
  const cancellation = new AbortController();
  const cancel = (): void => { cancellation.abort(options.signal?.reason); };
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const interrupt = (): void => { cancellation.abort(new Error("Worker shutdown requested.")); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  for (const signal of signals) process.on(signal, interrupt);
  let lock: Awaited<ReturnType<typeof acquireWorkerInstanceLock>> | undefined;
  let store: ReturnType<typeof openWorkerStore> | undefined;
  let git: ReturnType<typeof createWorkerGitManager> | undefined;
  let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
  let herdr: ReturnType<typeof createWorkerHerdr> | undefined;
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnostics>> | undefined;
  let cleanupLoop: Promise<void> | undefined;
  let cleanupFailure: unknown;
  const cleanupJobs = new Map<string, Promise<void>>();
  const failures: unknown[] = [];
  try {
    cancellation.signal.throwIfAborted();
    const configuration = await readWorkerConfiguration(paths, cancellation.signal);
    for (const repository of configuration.repositories) requireImplementedWorkerBackend(repository);
    const { serverUrl, serverToken } = await loadServerConfiguration(paths, cancellation.signal);
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    lock = await acquireWorkerInstanceLock(paths);
    cancellation.signal.throwIfAborted();
    const workerId = await ensureWorkerIdentity(paths, cancellation.signal);
    for (const directory of [paths.temporaryDirectory, paths.logsDirectory]) await mkdir(directory, { recursive: true, mode: 0o700 });
    store = openWorkerStore(paths.databaseFile);
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    const emit = diagnostics.emit;
    const buildPrompt = await createWorkerPromptBuilder(options.packageDirectory);
    const remote = createWorkerRemote({ serverUrl, serverToken });
    const sessionApi = createWorkerSessionApi(serverUrl, serverToken);
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory });
    const lazyHerdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, key) => {
      herdr ??= createWorkerHerdr({ paths, homeDirectory: options.homeDirectory });
      return Reflect.get(herdr, key);
    } });
    const launcher = createWebControllerLauncher({ homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, store, sessionApi, now: Date.now });
    const webBackend = createWebExecutionBackend({ homeDirectory: options.homeDirectory, store, git, launcher, platform, buildPrompt, emit, now: Date.now });
    const repositories: WorkerRepositoryAssignment[] = [];
    coordinator = createWorkerCoordinator({
      store, git, herdr: lazyHerdr, webBackend, verifyWebServer: sessionApi.verifySupport, remote, serverOrigin: serverUrl, workerId, platform,
      machine: machineDescription(platform), repositories, maxConcurrent: configuration.maxConcurrent,
      buildPrompt, emit, signal: cancellation.signal,
    });
    const cleanupCoordinator = coordinator;
    const cleanupDiagnostics = diagnostics;
    const cleanupStore = store;
    cleanupLoop = (async () => {
      while (!cancellation.signal.aborted) {
        for (const task of cleanupStore.listUnfinishedTasks()) {
          if (task.workerId !== workerId || (task.cleanup === null && task.control === null)) continue;
          const identity = { serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId };
          const key = JSON.stringify(identity);
          if (cleanupJobs.has(key)) continue;
          const job = (async () => {
            while (!cancellation.signal.aborted) {
              try { await cleanupCoordinator.advanceCommittedCleanups(identity); }
              catch (error) {
                if (isWorkerCancellation(error, cancellation.signal)) return;
                emit({ kind: "cleanup-error", message: "Committed cleanup could not advance; its original deadline and responsibility are retained.", error });
              }
              await cleanupDiagnostics.flush();
              const current = cleanupStore.getTask(identity);
              if (current === null) throw new Error("The committed cleanup record disappeared.");
              if (current.status === "done" || (current.cleanup === null && current.control === null)) return;
              const state = current.cleanup;
              if (current.control === null && state !== null && state.result !== null && state.agentStopped && backendResourcesClosed(state) && (state.kind === "shutdown" || state.worktreeDeleted)) return;
              const remaining = state === null ? 0 : state.deadline - Date.now();
              try { await delay(remaining > 0 ? Math.max(1, Math.min(1_000, remaining)) : 1_000, undefined, { signal: cancellation.signal }); }
              catch (error) { if (!isWorkerCancellation(error, cancellation.signal)) throw error; }
            }
          })().catch((error: unknown) => { if (cleanupFailure === undefined) cleanupFailure = error; cancellation.abort(error); });
          cleanupJobs.set(key, job);
          void job.then(() => { if (cleanupJobs.get(key) === job) cleanupJobs.delete(key); });
        }
        try { await delay(1_000, undefined, { signal: cancellation.signal }); }
        catch (error) { if (!isWorkerCancellation(error, cancellation.signal)) throw error; }
      }
    })().catch((error: unknown) => { if (cleanupFailure === undefined) cleanupFailure = error; cancellation.abort(error); });
    emit({ kind: "started", message: `Foreground worker ${workerId} on ${platform}; maxConcurrent=${configuration.maxConcurrent}; pollIntervalMs=${configuration.pollIntervalMs}; logs=${diagnostics.filename}.` });
    await remote.currentUserId(cancellation.signal);
    for (const repository of configuration.repositories) {
      cancellation.signal.throwIfAborted();
      const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, cancellation.signal);
      const binding = { serverOrigin: serverUrl, projectId: project.id, repoUrl: repository.remote, localPath: repository.path };
      const operation = createOperation({ signal: cancellation.signal });
      try { await git.prepareRepository(binding, operation); }
      finally { operation.dispose(); }
      const registered = store.registerProject(binding);
      const frozen = { agent: repository.agent, agentControlMode: repository.agentControlMode, model: repository.model, args: repository.args, recoveryLimit: repository.recoveryLimit };
      repositories.push({ project: registered, configuration: frozen });
    }
    let attachmentShown = false;
    while (!cancellation.signal.aborted) {
      try {
        await coordinator.tick();
        if (!attachmentShown && herdr !== undefined) {
          emit({ kind: "attach", message: `Original ready private Herdr session: ${JSON.stringify(herdr.attachment)}. Apply its environment and unsetEnvironment only to the attach process.` });
          attachmentShown = true;
        }
      }
      catch (error) {
        if (isWorkerCancellation(error, cancellation.signal)) break;
        if (cancellation.signal.aborted) throw error;
        emit({ kind: "reconciliation-error", message: "The reconciliation round failed; retained execution resources and unresolved writes require observation.", error });
      }
      await diagnostics.flush();
      if (cancellation.signal.aborted) break;
      try { await delay(configuration.pollIntervalMs, undefined, { signal: cancellation.signal }); }
      catch (error) { if (!isWorkerCancellation(error, cancellation.signal)) throw error; }
    }
  } catch (error) {
    if (!isWorkerCancellation(error, cancellation.signal)) failures.push(error);
  } finally {
    if (!cancellation.signal.aborted) cancellation.abort(new Error("Worker runtime is closing."));
    await cleanupLoop;
    await Promise.all(cleanupJobs.values());
    if (cleanupFailure !== undefined && !failures.includes(cleanupFailure)) failures.push(cleanupFailure);
    if (coordinator !== undefined) {
      try {
        diagnostics?.emit({ kind: "shutdown", message: "Stopping acquisitions and ordinary input; cleaning original executions with their persisted deadlines." });
        const stopped = await coordinator.shutdown();
        if (!stopped) throw new Error("Original task agents are not all confirmed stopped; their private Herdr instance was retained.");
        const operation = createOperation({ limits: { totalMs: 30_000 } });
        try {
          const proof = herdr === undefined ? { webControllersStopped: true } : await herdr.stopInstance(operation);
          diagnostics?.emit({ kind: "stopped", message: `Worker backend stop confirmed: ${JSON.stringify(proof)}. Unfinished claims, worktrees and native history are retained.` });
        } finally { operation.dispose(); }
      } catch (error) { failures.push(error); }
    }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await lock?.release(); } catch (error) { failures.push(error); }
    try { await diagnostics?.flush(); } catch (error) { failures.push(error); }
    for (const signal of signals) process.off(signal, interrupt);
    options.signal?.removeEventListener("abort", cancel);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Worker execution or shutdown failed.");
};


export const runWorkerControl = async (options: {
  homeDirectory: string; packageDirectory: string; request: WorkerControlRequest;
  log?: (message: string) => void; signal?: AbortSignal;
}): Promise<void> => {
  const platform = currentWorkerPlatform();
  const paths = resolveWorkerPaths(options.homeDirectory);
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(options.signal?.reason);
  const interrupt = (): void => cancellation.abort(new Error("Worker management interrupted; the persisted intent is retained."));
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  for (const signal of signals) process.on(signal, interrupt);
  let lock: Awaited<ReturnType<typeof tryAcquireWorkerInstanceLock>> | undefined;
  let store: ReturnType<typeof openWorkerStore> | undefined;
  let git: ReturnType<typeof createWorkerGitManager> | undefined;
  let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnostics>> | undefined;
  const failures: unknown[] = [];
  try {
    cancellation.signal.throwIfAborted();
    const configuration = await readWorkerConfiguration(paths, cancellation.signal);
    const { serverUrl, serverToken } = await loadServerConfiguration(paths, cancellation.signal);
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    lock = await tryAcquireWorkerInstanceLock(paths);
    const workerId = await ensureWorkerIdentity(paths, cancellation.signal);
    store = openWorkerStore(paths.databaseFile);
    const remote = createWorkerRemote({ serverUrl, serverToken });
    const sessionApi = createWorkerSessionApi(serverUrl, serverToken);
    await remote.currentUserId(cancellation.signal);
    diagnostics = await createWorkerDiagnostics({ paths, workerId, platform, ...(options.log === undefined ? {} : { log: options.log }), secrets: [serverToken] });
    const repositories: WorkerRepositoryAssignment[] = [];
    if (options.request.kind === "resume") {
      for (const repository of configuration.repositories) {
        if (options.request.projectId !== undefined && repository.projectId !== undefined && repository.projectId !== options.request.projectId) continue;
        const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, cancellation.signal);
        if (options.request.projectId !== undefined && project.id !== options.request.projectId) continue;
        const binding = store.registerProject({ serverOrigin: serverUrl, projectId: project.id, repoUrl: repository.remote, localPath: repository.path });
        repositories.push({ project: binding, configuration: { agent: repository.agent, agentControlMode: repository.agentControlMode, model: repository.model, args: repository.args, recoveryLimit: repository.recoveryLimit } });
      }
    }
    const result = await submitWorkerControl({ store, remote, serverOrigin: serverUrl, workerId, platform, machine: machineDescription(platform), repositories, verifyWebServer: sessionApi.verifySupport, request: options.request, signal: cancellation.signal });
    diagnostics.emit({ kind: "management", ...(result.task === null ? {} : { task: result.task }), message: result.message });
    await diagnostics.flush();
    if (result.task !== null && options.request.kind !== "resume") {
      const identity = result.task;
      let lastWaitingState: string | null = null;
      while (true) {
        cancellation.signal.throwIfAborted();
        let task = store.getTask(identity);
        if (task === null) throw new Error("The managed execution record disappeared.");
        if (task.control?.submission === "unknown") task = await createWorkerControlDriver({ store, remote, serverOrigin: serverUrl, now: Date.now }).advance(task, cancellation.signal, { submit: false });
        if (task.status === "done") {
          diagnostics.emit({ kind: "management-complete", task, message: `Management finished for claim ${task.claimId}; outcome=${task.control?.outcome ?? "ownership-ended"}.` });
          break;
        }
        if (task.control?.submission === "rejected") throw new Error(`Management refused for claim ${task.claimId}: ${task.control.error}. A new explicit decision and version are required.`);
        if (task.control?.submission === "unknown") throw new Error(`Management result is unknown for claim ${task.claimId}; the original intent and claim identities are retained for reconciliation.`);
        if (lock === null) lock = await tryAcquireWorkerInstanceLock(paths);
        if (lock !== null) {
          requireImplementedWorkerBackend(task.configuration);
          if (coordinator === undefined) {
            await mkdir(paths.temporaryDirectory, { recursive: true, mode: 0o700 });
            git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory });
            let actualHerdr: WorkerHerdrAdapter | undefined;
            const herdr = new Proxy({} as WorkerHerdrAdapter, { get: (_target, key) => { actualHerdr ??= createWorkerHerdr({ paths, homeDirectory: options.homeDirectory }); return Reflect.get(actualHerdr, key); } });
            const buildPrompt = await createWorkerPromptBuilder(options.packageDirectory);
            const launcher = createWebControllerLauncher({ homeDirectory: options.homeDirectory, packageDirectory: options.packageDirectory, store, sessionApi, now: Date.now });
            const webBackend = createWebExecutionBackend({ homeDirectory: options.homeDirectory, store, git, launcher, platform, buildPrompt, emit: diagnostics.emit, now: Date.now });
            coordinator = createWorkerCoordinator({ store, git, herdr, webBackend, verifyWebServer: sessionApi.verifySupport, remote, serverOrigin: serverUrl, workerId, platform, machine: machineDescription(platform), repositories, maxConcurrent: configuration.maxConcurrent, buildPrompt, emit: diagnostics.emit, signal: cancellation.signal });
          }
          if (options.request.kind === "retry") {
            await coordinator.advanceRetry(identity);
            const retried = store.getTask(identity);
            if (retried === null) throw new Error("The retried execution record disappeared.");
            diagnostics.emit({ kind: "retry", task: retried, message: `Explicit recovery processed for claim ${retried.claimId}; count=${retried.recovery.count}; pause=${retried.recovery.pauseReason ?? "none"}.` });
            break;
          }
          await coordinator.advanceCommittedCleanups(identity);
        } else if (options.request.kind === "retry") {
          diagnostics.emit({ kind: "retry-authorized", task, message: `Claim ${task.claimId} has one persisted extra recovery authorization; the foreground worker remains its sole controller.` });
          break;
        }
        await diagnostics.flush();
        const latest = store.getTask(identity);
        if (latest?.status === "done" || latest?.control?.submission === "unknown" || latest?.control?.submission === "rejected") continue;
        const waitingState = JSON.stringify({ cleanup: latest?.cleanup, control: latest?.control });
        if (waitingState !== lastWaitingState) {
          diagnostics.emit({ kind: "management-waiting", ...(latest === null ? {} : { task: latest }), message: `Waiting for the sole worker controller to finish management of claim ${task.claimId}.` });
          lastWaitingState = waitingState;
        }
        await delay(1_000, undefined, { signal: cancellation.signal });
      }
    }
  } catch (error) { failures.push(error); }
  finally {
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await lock?.release(); } catch (error) { failures.push(error); }
    try { await diagnostics?.flush(); } catch (error) { failures.push(error); }
    for (const signal of signals) process.off(signal, interrupt);
    options.signal?.removeEventListener("abort", cancel);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Worker management or resource disposal failed.");
};
