import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { controllerExecutionDirectory, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import type { ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { requestController } from "../../controller/local-client.js";
import { captureProcessProof, type ProcessProof } from "../../controller/process-proof.js";
import { ControllerStartupError } from "../../controller/startup.js";

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
  packageDirectory: string;
  ticket: ControllerLaunchTicket;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onSubmitting(): void | Promise<void>;
  onSpawned(proof: ProcessProof): void | Promise<void>;
  onObserved(snapshot: ControllerSnapshot): void | Promise<void>;
}): Promise<ControllerSnapshot> => {
  const { ticket, signal } = options;
  const directory = controllerExecutionDirectory(options.homeDirectory, ticket.executionId);
  const log = await open(path.join(directory, "controller.log"), "a", 0o600);
  try {
    signal.throwIfAborted();
    await options.onSubmitting();
    signal.throwIfAborted();
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [path.join(options.packageDirectory, "dist", "main.js"), "controller", ticket.provider, "--launch-id", ticket.launchId], {
        cwd: ticket.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd], windowsHide: true,
      });
    } catch (cause) {
      throw new ControllerStartupError({ state: "failed", reasonCode: "controller_launch_failed" }, "The operating system rejected the controller launch.", { cause });
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", cause => reject(new ControllerStartupError({ state: "failed", reasonCode: "controller_launch_failed" }, "The operating system rejected the controller launch.", { cause })));
    });
    child.unref();
    if (child.pid === undefined) throw new Error("Controller spawn did not establish its process identity.");
    await options.onSpawned(await captureProcessProof(child.pid));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      let snapshot: ControllerSnapshot | undefined;
      try { snapshot = await observeControllerProcess(ticket, signal); }
      catch {
        if (child.exitCode !== null || child.signalCode !== null) throw new ControllerStartupError({ state: "unknown", reasonCode: "controller_start_unknown" }, "Controller exited before its authenticated initialization; inspect its private log.");
      }
      if (snapshot !== undefined) {
        await options.onObserved(snapshot);
        return snapshot;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new ControllerStartupError({ state: "unknown", reasonCode: "controller_start_unknown" }, "Controller startup outcome is unknown; the original process and launch intent are retained.");
  } finally { await log.close(); }
};
