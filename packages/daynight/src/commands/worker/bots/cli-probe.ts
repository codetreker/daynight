import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Operation } from "../../../api/operation.js";
import { captureProcessProof, confirmControllerProcessesStopped, stopControllerProcesses, type ProcessProof } from "../../controller/process-proof.js";
import { createControllerJob, inspectControllerJob } from "../../controller/windows-job.js";
import type { HerdrCommandResult } from "../herdr/command.js";
import { botCliProbeChildSource } from "./cli-probe-child.js";

export type BotCliProbeOwnership = {
  readonly launchId: string;
  readonly pid: number | null;
  readonly process: ProcessProof | null;
  readonly jobObjectName: string | null;
  readonly targetStarted: boolean;
};

export class BotCliProbeCleanupError extends Error {
  constructor(readonly ownership: BotCliProbeOwnership, readonly retryCleanup: () => Promise<void>) {
    super("Bot CLI probe process cleanup is unconfirmed; retain its ownership and retry cleanup before releasing aliases.");
    this.name = "BotCliProbeCleanupError";
  }
}

export type BotCliProbe = {
  readonly ownership: BotCliProbeOwnership;
  run(file: string, args: readonly string[]): Promise<HerdrCommandResult>;
  close(): Promise<void>;
};

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * One gated supervisor owns the whole capability query set. Every caller must
 * close it, including after successful help; direct command closure never proves
 * that descendants stopped. Cleanup has its own finite grace after cancellation.
 */
export const createBotCliProbe = async (
  options: { environment: NodeJS.ProcessEnv; cwd: string },
  operation: Operation,
): Promise<BotCliProbe> => {
  operation.check();
  const launchId = randomUUID();
  const targetEnvironment = { ...options.environment };
  const guardianEnvironment = { ...targetEnvironment };
  // User Node preload hooks belong to the CLI, after its process scope is owned.
  for (const key of Object.keys(guardianEnvironment)) if (key.toUpperCase() === "NODE_OPTIONS") delete guardianEnvironment[key];
  let child: ChildProcess | undefined, closed = false, started = false, stopped = false;
  let proof: ProcessProof | null = null, jobObjectName: string | null = null;
  let stopPending: Promise<void> | undefined;
  let waiting: { resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
  let terminalFailure: Error | undefined;
  const ownership = (): BotCliProbeOwnership => ({ launchId, pid: child?.pid ?? null, process: proof, jobObjectName, targetStarted: started });
  const fail = (): void => {
    terminalFailure = new Error("Bot CLI probe supervisor failed.");
    waiting?.reject(terminalFailure);
  };
  const verifyGuardian = (): void => {
    if (child?.pid === undefined || closed || child.exitCode !== null || child.signalCode !== null
      || terminalFailure !== undefined || !child.connected || proof !== null && (proof.pid !== child.pid || proof.parentPid !== process.pid)) {
      throw new Error("Bot CLI probe supervisor ownership changed before command admission.");
    }
  };
  const waitMessage = (milliseconds: number): Promise<Record<string, unknown>> => {
    operation.check();
    if (terminalFailure !== undefined) return Promise.reject(terminalFailure);
    if (waiting !== undefined) return Promise.reject(new Error("Bot CLI probes must run sequentially."));
    return new Promise((resolve, reject) => {
      const finish = (action: () => void): void => { clearTimeout(timer); operation.signal.removeEventListener("abort", cancel); waiting = undefined; action(); };
      const cancel = (): void => finish(() => reject(new Error("Bot CLI probe was cancelled.")));
      const timer = setTimeout(() => finish(() => reject(new Error("Bot CLI probe deadline elapsed."))), Math.max(1, Math.min(milliseconds, operation.remainingMs())));
      waiting = { resolve: message => finish(() => resolve(message)), reject: error => finish(() => reject(error)) };
      operation.signal.addEventListener("abort", cancel, { once: true });
      if (operation.signal.aborted) cancel();
    });
  };
  const stop = async (): Promise<void> => {
    if (stopped) return;
    const deadline = Date.now() + 60_000;
    try {
      if (started) {
        if (proof === null) throw new Error("The probe ownership proof is unavailable.");
        await stopControllerProcesses(proof, [], deadline);
        if (!await confirmControllerProcessesStopped(proof, [])) throw new Error("Probe descendants remain active.");
      } else {
        // No CLI target passed the gate. Only this known supervisor can exist,
        // including an uncertain response while it was assigned to its job.
        if (jobObjectName !== null) await inspectControllerJob(jobObjectName, true);
        if (child?.pid !== undefined && !closed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      while (child !== undefined && !closed && Date.now() < deadline) await delay(20);
      if (child !== undefined && !closed) throw new Error("Probe supervisor streams remain open.");
      stopped = true;
    } catch { throw new BotCliProbeCleanupError(ownership(), close); }
  };
  const close = async (): Promise<void> => {
    stopPending ??= stop();
    try { await stopPending; }
    finally { stopPending = undefined; }
  };
  try {
    // Register the waiter before spawning so a fast guardian cannot lose ready.
    const ready = waitMessage(10_000);
    void ready.catch(() => {});
    try {
      child = spawn(process.execPath, ["-e", botCliProbeChildSource, createRequire(import.meta.url).resolve("cross-spawn")], {
        env: guardianEnvironment, cwd: options.cwd, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch { fail(); }
    child?.on("message", message => {
      const parsed = record(message);
      if (parsed === undefined) { fail(); return; }
      waiting?.resolve(parsed);
    });
    child?.once("error", fail);
    child?.once("close", () => { closed = true; if (!stopped) fail(); });
    if ((await ready).type !== "ready" || child?.pid === undefined) throw new Error("Bot CLI probe supervisor did not become ready.");
    verifyGuardian();
    proof = await captureProcessProof(child.pid);
    verifyGuardian();
    if (process.platform === "win32") {
      jobObjectName = `Local\\Daynight-${launchId}`;
      await createControllerJob(launchId, child.pid);
      verifyGuardian();
      proof = { ...proof, jobObjectName };
    } else if (proof.processGroupId !== proof.pid) throw new Error("Bot CLI probe supervisor does not own its process group.");
    operation.check();
    return {
      get ownership() { return ownership(); },
      close,
      run: async (file, args) => {
        if (stopped || stopPending !== undefined) throw new Error("Bot CLI probe scope is closed.");
        verifyGuardian();
        const response = waitMessage(operation.limits.requestMs);
        void response.catch(() => {});
        started = true;
        child!.send({ type: "run", file, args, environment: targetEnvironment }, error => { if (error !== null) fail(); });
        const message = await response;
        operation.check();
        if (message.type !== "result" || message.code !== 0 || message.signal !== null || typeof message.stdout !== "string" || typeof message.stderr !== "string") {
          throw new Error("Bot CLI capability command failed.");
        }
        operation.consume(Buffer.byteLength(message.stdout) + Buffer.byteLength(message.stderr));
        return { stdout: message.stdout, stderr: message.stderr };
      },
    };
  } catch (error) {
    await close();
    operation.check();
    throw error;
  }
};
