import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createOperation, OperationError } from "../../api/operation.js";
import type { TaskPlatform, WorkerMachine } from "../../api/types.js";
import { loadServerConfiguration } from "../../config/server.js";
import { readWorkerConfiguration } from "./config.js";
import { createWorkerCoordinator } from "./coordinator.js";
import type { WorkerRepositoryAssignment } from "./coordinator.js";
import { createWorkerDiagnostics } from "./diagnostics.js";
import { createWorkerHerdr } from "./herdr.js";
import { ensureWorkerIdentity } from "./identity.js";
import { acquireWorkerInstanceLock } from "./instance-lock.js";
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

const cancelled = (error: unknown, signal: AbortSignal): boolean => signal.aborted && (
  error === signal.reason ||
  (error instanceof OperationError && error.kind === "cancelled" && error.cause === signal.reason) ||
  (error instanceof Error && error.cause !== undefined && cancelled(error.cause, signal))
);

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
  const failures: unknown[] = [];
  try {
    cancellation.signal.throwIfAborted();
    const configuration = await readWorkerConfiguration(paths, cancellation.signal);
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
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory });
    herdr = createWorkerHerdr({ paths, homeDirectory: options.homeDirectory });
    const repositories: WorkerRepositoryAssignment[] = [];
    coordinator = createWorkerCoordinator({
      store, git, herdr, remote, serverOrigin: serverUrl, workerId, platform,
      machine: machineDescription(platform), repositories, maxConcurrent: configuration.maxConcurrent,
      buildPrompt, emit, signal: cancellation.signal,
    });
    const cleanupCoordinator = coordinator;
    const cleanupDiagnostics = diagnostics;
    const cleanupStore = store;
    cleanupLoop = (async () => {
      while (!cancellation.signal.aborted) {
        try { await cleanupCoordinator.advanceCommittedCleanups(); }
        catch (error) {
          if (cancelled(error, cancellation.signal)) break;
          emit({ kind: "cleanup-error", message: "Committed cleanup could not advance; its original deadline and responsibility are retained.", error });
        }
        await cleanupDiagnostics.flush();
        const observedAt = Date.now();
        const interval = Math.max(1, cleanupStore.listUnfinishedTasks().reduce((waiting, task) => {
          if (task.serverOrigin !== serverUrl || task.workerId !== workerId || task.cleanup === null || task.cleanup.result !== null) return waiting;
          const remaining = task.cleanup.deadline - observedAt;
          return remaining > 0 ? Math.min(waiting, remaining) : waiting;
        }, 1_000));
        try { await delay(interval, undefined, { signal: cancellation.signal }); }
        catch (error) { if (!cancelled(error, cancellation.signal)) throw error; }
      }
    })().catch((error: unknown) => { cleanupFailure = error; cancellation.abort(error); });
    emit({ kind: "started", message: `Foreground worker ${workerId} on ${platform}; maxConcurrent=${configuration.maxConcurrent}; pollIntervalMs=${configuration.pollIntervalMs}; logs=${diagnostics.filename}.` });
    for (const repository of configuration.repositories) {
      cancellation.signal.throwIfAborted();
      const project = await remote.resolveProject({ repoUrl: repository.remote, ...(repository.projectId === undefined ? {} : { projectId: repository.projectId }) }, cancellation.signal);
      const binding = { serverOrigin: serverUrl, projectId: project.id, repoUrl: repository.remote, localPath: repository.path };
      const operation = createOperation({ signal: cancellation.signal });
      try { await git.prepareRepository(binding, operation); }
      finally { operation.dispose(); }
      const registered = store.registerProject(binding);
      const frozen = { agent: repository.agent, model: repository.model, args: repository.args, recoveryLimit: repository.recoveryLimit };
      repositories.push({ project: registered, configuration: frozen });
    }
    let attachmentShown = false;
    while (!cancellation.signal.aborted) {
      try {
        await coordinator.tick();
        if (!attachmentShown) {
          emit({ kind: "attach", message: `Original ready private Herdr session: ${JSON.stringify(herdr.attachment)}. Apply its environment and unsetEnvironment only to the attach process.` });
          attachmentShown = true;
        }
      }
      catch (error) {
        if (cancelled(error, cancellation.signal)) break;
        if (cancellation.signal.aborted) throw error;
        emit({ kind: "reconciliation-error", message: "The reconciliation round failed; retained execution resources and unresolved writes require observation.", error });
      }
      await diagnostics.flush();
      if (cancellation.signal.aborted) break;
      try { await delay(configuration.pollIntervalMs, undefined, { signal: cancellation.signal }); }
      catch (error) { if (!cancelled(error, cancellation.signal)) throw error; }
    }
  } catch (error) {
    if (!cancelled(error, cancellation.signal)) failures.push(error);
  } finally {
    if (!cancellation.signal.aborted) cancellation.abort(new Error("Worker runtime is closing."));
    await cleanupLoop;
    if (cleanupFailure !== undefined && !failures.includes(cleanupFailure)) failures.push(cleanupFailure);
    if (coordinator !== undefined && herdr !== undefined) {
      try {
        diagnostics?.emit({ kind: "shutdown", message: "Stopping acquisitions and ordinary input; cleaning original executions with their persisted deadlines." });
        const stopped = await coordinator.shutdown();
        if (!stopped) throw new Error("Original task agents are not all confirmed stopped; their private Herdr instance was retained.");
        const operation = createOperation({ limits: { totalMs: 30_000 } });
        try {
          const proof = await herdr.stopInstance(operation);
          diagnostics?.emit({ kind: "stopped", message: `Private Herdr stop confirmed: ${JSON.stringify(proof)}. Unfinished claims, worktrees and native history are retained.` });
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
