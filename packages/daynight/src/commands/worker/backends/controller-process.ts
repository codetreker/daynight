import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSuspendedProcess, type WindowsSuspendedProcess } from "../../../platform/windows-suspended-process.js";
import { createControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../controller/windows-job.js";
import { controllerExecutionDirectory, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import type { ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { requestController } from "../../controller/local-client.js";
import { captureProcessProof, type ProcessProof } from "../../controller/process-proof.js";
import { ControllerStartupError } from "../../controller/startup.js";
import { reconcileSubmittedControllerLaunch } from "../../controller/launch-observation.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen, isControllerStorageLockHeld } from "../../controller/storage-lock.js";
import { ControllerStorageWaitingError, prepareControllerStorage } from "../../controller/storage-preparation.js";
import { SqliteAccessError } from "../../../platform/sqlite-error.js";

export const prepareControllerLaunchStorage = (homeDirectory: string, ticket: ControllerLaunchTicket, storageStateDirectory?: string): void => {
  const journalFile = path.join(controllerExecutionDirectory(homeDirectory, ticket.executionId, storageStateDirectory), "journal.sqlite");
  let permit: ReturnType<typeof acquireControllerStoragePermit>;
  try { permit = acquireControllerStoragePermit(journalFile); }
  catch (cause) {
    if (cause instanceof Error && isControllerStorageLockHeld(cause)) throw new ControllerStorageWaitingError("lock_busy", cause);
    throw cause;
  }
  let failure: unknown, failed = false, committed = false;
  try {
    const prepared = prepareControllerStorage({ journalFile, mode: "writer", ticket }, permit);
    if (prepared.kind === "waiting") throw new ControllerStorageWaitingError(prepared.reason, prepared.cause);
    committed = true;
  } catch (cause) { failed = true; failure = cause; }
  try { if (!failed || !controllerStorageConnectionIsOpen(failure)) permit.release(); }
  catch (cause) {
    const releaseFailure = failed ? new AggregateError([failure, cause], "Controller launch preparation and storage release failed.", { cause: failure }) : cause;
    if (committed) throw new SqliteAccessError("cleanup-failed", { database: "controller-journal", file: journalFile, phase: "release" }, { cause: releaseFailure, outcome: "committed", connectionClosed: true });
    throw releaseFailure;
  }
  if (failed) throw failure;
};

/** Serialize mutations of one execution without blocking unrelated executions. */
export const createControllerExecutionSerializer = () => {
  const tails = new Map<string, Promise<void>>();
  return async <T>(executionId: string, action: () => Promise<T>): Promise<T> => {
    const previous = tails.get(executionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(executionId, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (tails.get(executionId) === tail) tails.delete(executionId); }
  };
};

/** IPC authenticates the original execution fence; observing never submits input. */
export const observeControllerProcess = async (ticket: ControllerLaunchTicket, signal: AbortSignal, timeoutMs = 1000): Promise<ControllerSnapshot> =>
  (await requestController(ticket, { kind: "observe" }, { signal, timeoutMs })).snapshot;

/**
 * Launch only after the caller has established that its durable intent is unsubmitted.
 * Callbacks retain submission and process evidence before further side effects.
 * An unknown result never authorizes another launch; the caller owns reconciliation.
 */
export const launchControllerProcess = async (options: {
  homeDirectory: string;
  storageStateDirectory?: string;
  packageDirectory: string;
  ticket: ControllerLaunchTicket;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onSubmitting(): void | Promise<void>;
  /** Keep original birth handles reachable until failed pre-dispatch cleanup joins. */
  retainBirthCleanup(cleanup: (deadline: number) => Promise<void>): () => void;
  /** Commit the proof, then retain supplied native ownership before returning. */
  onSpawned(proof: ProcessProof, ownership?: { lease: ControllerJobLease; closeHandles(): void }): void | Promise<void>;
  onObserved(snapshot: ControllerSnapshot): void | Promise<void>;
}): Promise<ControllerSnapshot> => {
  const { ticket, signal } = options;
  signal.throwIfAborted();
  prepareControllerLaunchStorage(options.homeDirectory, ticket, options.storageStateDirectory);
  const directory = controllerExecutionDirectory(options.homeDirectory, ticket.executionId, options.storageStateDirectory);
  const log = await open(path.join(directory, "controller.log"), "a", 0o600);
  try {
    signal.throwIfAborted();
    // Synchronous admission checks and submission records must be kept in the same turn as spawn.
    const submission = options.onSubmitting();
    if (submission !== undefined) await submission;
    signal.throwIfAborted();
    const bootstrap = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../../dist/commands/worker/backends/controller-bootstrap.js" : "./controller-bootstrap.js", import.meta.url));
    const args = [bootstrap, path.join(options.packageDirectory, "dist", "main.js"), ticket.provider, ticket.launchId, path.join(directory, "controller.log")];
    const environment = { ...options.env, DAYNIGHT_CONTROLLER_STORAGE_DIR: options.storageStateDirectory,
      ...(process.platform === "win32" ? { DAYNIGHT_CONTROLLER_ASSIGNED_JOB: ticket.launchId } : {}) };
    for (const key of Object.keys(environment)) if (key.toUpperCase() === "NODE_OPTIONS") delete environment[key as keyof typeof environment];
    let child: ChildProcess | undefined, suspended: WindowsSuspendedProcess | undefined, lease: ControllerJobLease | undefined;
    let spawnProof: ProcessProof, released = false;
    try {
      try {
      if (process.platform === "win32") suspended = await createSuspendedProcess({ file: process.execPath, args, cwd: ticket.cwd, environment });
      else {
        child = spawn(process.execPath, args, { cwd: ticket.cwd, env: environment, detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"], windowsHide: true });
        await new Promise<void>((resolve, reject) => {
          child!.once("spawn", resolve);
          child!.once("error", cause => reject(new ControllerStartupError({ state: "failed", reasonCode: "controller_launch_failed" }, "The operating system rejected the controller launch.", { cause })));
        });
      }
      } catch (cause) {
        if (cause instanceof ControllerStartupError) throw cause;
        throw new ControllerStartupError({ state: "failed", reasonCode: "controller_launch_failed" }, "The operating system rejected the controller launch.", { cause });
      }
      const pid = suspended?.pid ?? child?.pid;
      if (pid === undefined) throw new Error("Controller spawn did not establish its process identity.");
      spawnProof = await captureProcessProof(pid);
      if (suspended !== undefined) {
        spawnProof = { ...spawnProof, jobObjectName: `Local\\Daynight-${ticket.launchId}` };
        lease = await createControllerJobLease(ticket.launchId, spawnProof, Date.now() + 15_000);
      }
      await options.onSpawned(spawnProof, lease === undefined ? undefined : { lease, closeHandles: () => suspended!.close() });
      if (lease !== undefined) lease = undefined;
      signal.throwIfAborted();
      if (suspended !== undefined) {
        suspended.resume(); released = true;

      } else {
        if (!child!.connected) throw new Error("Controller launch gate disconnected before dispatch.");
        child!.send({ launchId: ticket.launchId }); released = true;
        child!.unref(); child!.channel?.unref();
      }
    } catch (error) {
      if (!released && (suspended !== undefined || child !== undefined)) {
        let closedLeaseFailure: unknown;
        const cleanup = async (deadline: number): Promise<void> => {
          if (closedLeaseFailure !== undefined) throw closedLeaseFailure;
          if (suspended !== undefined) {
            suspended.terminate();
            while (!suspended.hasExited() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            suspended.close();
            if (lease !== undefined) {
              try { releaseControllerJobLease(lease); lease = undefined; }
              catch (failure) { closedLeaseFailure = failure; throw failure; }
            }
          } else if (child !== undefined && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { child!.off("close", finished); reject(new Error("Controller launch gate stop remains unconfirmed.", { cause: error })); }, Math.max(1, deadline - Date.now()));
              const finished = () => { clearTimeout(timer); resolve(); };
              child!.once("close", finished);
            });
          }
        };
        const forget = options.retainBirthCleanup(cleanup);
        try { await cleanup(Date.now() + 5000); forget(); }
        catch (failure) { throw new AggregateError([error, failure], "Controller launch failed with retained original birth handles.", { cause: error }); }
      }
      throw error;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const observation = await reconcileSubmittedControllerLaunch({ journalFile: path.join(directory, "journal.sqlite"), ticket, spawnProof, signal });
      if (observation.kind === "observed") {
        await options.onObserved(observation.snapshot);
        return observation.snapshot;
      }
      if (observation.kind === "controller-exited" || observation.kind === "pre-writer-exited") throw new ControllerStartupError({ state: "unknown", reasonCode: "controller_start_unknown" }, `Controller exited before authenticated initialization (${observation.kind}); its launch identity is retained.`);
      if (observation.kind === "unknown") throw new ControllerStartupError({ state: "unknown", reasonCode: "controller_start_unknown" }, "Controller process identity could not be established.", { cause: observation.cause });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new ControllerStartupError({ state: "unknown", reasonCode: "controller_start_unknown" }, "Controller startup outcome is unknown; the original process and launch intent are retained.");
  } finally { await log.close(); }
};
