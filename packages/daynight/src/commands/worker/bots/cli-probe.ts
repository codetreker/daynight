import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Operation } from "../../../api/operation.js";
import { captureProcessProof, confirmControllerProcessesStopped, stopControllerProcesses, type ProcessProof } from "../../controller/process-proof.js";
import { createWindowsBotJobLease, WindowsBotJobError, WindowsBotJobSetupError, type WindowsBotJobLease } from "./windows-job-lease.js";
import type { OwnedCommandResult } from "../owned-command.js";
import { currentOwnedCommandLifecycle, OwnedCommandAdmissionError, type OwnedCommandLifecycleEvent } from "../owned-command-lifecycle.js";
import { withinExecutionDeadline } from "../execution-scope.js";
import { createSuspendedNodeChild, type GatedNodeChild } from "../suspended-node-child.js";
import { botCliProbeChildSource } from "./cli-probe-child.js";

export type BotCliProbeOwnership = {
  readonly launchId: string;
  readonly pid: number | null;
  readonly process: ProcessProof | null;
  readonly jobObjectName: string | null;
  readonly targetStarted: boolean;
};

export class BotCliProbeCleanupError extends Error {
  constructor(readonly ownership: BotCliProbeOwnership, readonly retryCleanup: () => Promise<void>, readonly failure?: { stage: string; nativeStage?: string; win32Code?: number }) {
    super("Bot CLI probe process cleanup is unconfirmed; retain its ownership and retry cleanup before releasing aliases.");
    this.name = "BotCliProbeCleanupError";
  }
}

export type BotCliProbe = {
  readonly ownership: BotCliProbeOwnership;
  run(file: string, args: readonly string[]): Promise<OwnedCommandResult>;
  close(): Promise<void>;
};

const retained = new Map<string, { ownership(): BotCliProbeOwnership; close(): Promise<void> }>();
/** Failed cleanup remains owned even if its original caller no longer holds the Error. */
export const retainedBotCliProbes = (): readonly BotCliProbeOwnership[] => [...retained.values()].map(probe => probe.ownership());
export const reconcileBotCliProbe = async (launchId: string): Promise<void> => {
  const probe = retained.get(launchId);
  if (probe === undefined) throw new Error("The original Bot CLI probe responsibility is unavailable.");
  await probe.close();
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
  let child: ChildProcess | GatedNodeChild | undefined, closed = false, started = false, stopped = false, nativeStopped = false;
  let suspended: Awaited<ReturnType<typeof createSuspendedNodeChild>> | undefined;
  let handlesClosed = false;
  const initialized = Promise.withResolvers<void>();
  let proof: ProcessProof | null = null, jobObjectName: string | null = null;
  let windowsJob: WindowsBotJobLease | undefined;
  let stopPending: Promise<void> | undefined;
  let waiting: { resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
  let terminalFailure: Error | undefined;
  const sink = currentOwnedCommandLifecycle();
  let sequence = 0;
  let rejectedPreparation: OwnedCommandAdmissionError | undefined;
  const saves: { event: OwnedCommandLifecycleEvent; attempted?: true; work?: Promise<void> }[] = [];
  const save = async (stage: OwnedCommandLifecycleEvent["stage"]): Promise<void> => {
    if (sink === undefined) return;
    saves.push({ event: { resourceId: launchId, sequence: ++sequence, stage, proof } });
    const deadline = Date.now() + 10_000;
    while (saves.length) {
      const entry = saves[0]!;
      if (entry.work === undefined) {
        const firstAttempt = entry.attempted !== true;
        entry.attempted = true;
        const work = Promise.resolve().then(() => sink(entry.event));
        entry.work = work;
        // A timed-out save is still owned. Only a settled refusal can be retried.
        void work.catch(error => {
          // A later admission refusal cannot erase an earlier write's unknown
          // outcome. Only the first attempt can prove no reservation existed.
          if (firstAttempt && entry.event.stage === "prepared" && error instanceof OwnedCommandAdmissionError) rejectedPreparation = error;
          if (entry.work === work) delete entry.work;
        });
      }
      await withinExecutionDeadline(entry.work, deadline);
      saves.shift();
    }
  };
  const ownership = (): BotCliProbeOwnership => ({ launchId, pid: child?.pid ?? null, process: proof, jobObjectName, targetStarted: started });
  const fail = (): void => {
    terminalFailure = new Error("Bot CLI probe supervisor failed.");
    waiting?.reject(terminalFailure);
  };
  const verifyGuardian = (connected = true): void => {
    if (child?.pid === undefined || closed || child.exitCode !== null || child.signalCode !== null
      || terminalFailure !== undefined || connected && !child.connected || proof !== null && (proof.pid !== child.pid || proof.parentPid !== process.pid)) {
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
    const retireRejectedPreparation = (): boolean => {
      if (rejectedPreparation === undefined || child !== undefined) return false;
      saves.length = 0; stopped = true; nativeStopped = true; retained.delete(launchId);
      return true;
    };
    if (retireRejectedPreparation()) return;
    const deadline = Date.now() + 60_000;
    let stage = "stop-owned-scope";
    try {
      if (!nativeStopped) {
        if (windowsJob !== undefined) {
          stage = "terminate-job";
          windowsJob.terminate();
          stage = "inspect-job";
          while (Date.now() < deadline && windowsJob.inspect().length !== 0) await delay(20);
          if (windowsJob.inspect().length !== 0) throw new Error("Windows Bot probe Job Object members remain active.");
        } else if (started) {
          if (proof === null) throw new Error("The probe ownership proof is unavailable.");
          await stopControllerProcesses(proof, [], deadline);
          if (!await confirmControllerProcessesStopped(proof, [])) throw new Error("Probe descendants remain active.");
        }
        // Before the command gate, only this known guardian can need direct
        // termination, including when native job assignment failed.
        if (!started && child?.pid !== undefined && !closed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        stage = "join-guardian";
        while (child !== undefined && !closed && Date.now() < deadline) await delay(20);
        if (child !== undefined && !closed) throw new Error("Probe supervisor streams remain open.");
        stage = "close-job-handle";
        windowsJob?.close();
        if (!handlesClosed && suspended !== undefined) { suspended.closeHandles(); handlesClosed = true; }
        nativeStopped = true;
      }
      stage = "save-stopped";
      await save("stopped");
      stopped = true;
      retained.delete(launchId);
    } catch (error) {
      if (retireRejectedPreparation()) return;
      try { await save("unknown"); } catch { /* The original save and cleanup remain strongly owned for reconciliation. */ }
      throw new BotCliProbeCleanupError(ownership(), close, { stage, ...(error instanceof WindowsBotJobError ? { nativeStage: error.stage, win32Code: error.win32Code } : {}) });
    }
  };
  const close = async (): Promise<void> => {
    stopPending ??= stop();
    try { await stopPending; }
    finally { stopPending = undefined; }
  };
  retained.set(launchId, { ownership, close: async () => {
    // The original constructor owns birth and its writes. Cancellation can
    // arrive before its gate opens; recovery must join that same constructor
    // before stopping, without inferring closure from a missing proof.
    await initialized.promise;
    await close();
  } });
  try {
    await save("prepared");
    operation.check();
    // Register the waiter before spawning so a fast guardian cannot lose ready.
    const ready = process.platform === "win32" ? undefined : waitMessage(10_000);
    void ready?.catch(() => {});
    try {
      const args = [createRequire(import.meta.url).resolve("cross-spawn")];
      if (process.platform === "win32") {
        suspended = await createSuspendedNodeChild({ source: botCliProbeChildSource, args, environment: guardianEnvironment, cwd: options.cwd });
        child = suspended.child;
        child.stdout.resume(); child.stderr.resume();
      } else child = spawn(process.execPath, ["-e", botCliProbeChildSource, ...args], {
        env: guardianEnvironment, cwd: options.cwd, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) { fail(); throw error; }
    child?.on("message", message => {
      const parsed = record(message);
      if (parsed === undefined) { fail(); return; }
      waiting?.resolve(parsed);
    });
    child?.once("error", fail);
    child?.once("close", () => { closed = true; if (!stopped) fail(); });
    if (suspended === undefined && (await ready)?.type !== "ready" || child?.pid === undefined) throw new Error("Bot CLI probe supervisor did not become ready.");
    verifyGuardian(suspended === undefined);
    proof = await captureProcessProof(child.pid, Math.max(1, Math.floor(Math.min(process.platform === "win32" ? 15_000 : 5_000, operation.remainingMs()))));
    verifyGuardian(suspended === undefined);
    if (process.platform === "win32") {
      windowsJob = await createWindowsBotJobLease(launchId);
      jobObjectName = windowsJob.name;
      verifyGuardian(false);
      windowsJob.assign(child.pid);
      if (!windowsJob.inspect().includes(child.pid)) throw new Error("The Windows Bot probe guardian is absent from its owned job.");
      verifyGuardian(false);
      proof = { ...proof, jobObjectName };
    } else if (proof.processGroupId !== proof.pid) throw new Error("Bot CLI probe supervisor does not own its process group.");
    await save("bound");
    operation.check();
    if (suspended !== undefined) {
      const resumed = waitMessage(10_000);
      void resumed.catch(() => {});
      suspended.resume();
      if ((await resumed).type !== "ready") throw new Error("Bot CLI probe supervisor did not become ready.");
    }
    verifyGuardian();
    operation.check();
    initialized.resolve();
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
        if (message.type === "failure" && message.code === "limit_exceeded") throw Object.assign(new Error("Bot CLI capability output exceeds its limit."), { code: "limit_exceeded" as const });
        if (message.type !== "result" || message.code !== 0 || message.signal !== null || typeof message.stdout !== "string" || typeof message.stderr !== "string") {
          throw new Error("Bot CLI capability command failed.");
        }
        operation.consume(Buffer.byteLength(message.stdout) + Buffer.byteLength(message.stderr));
        return { stdout: message.stdout, stderr: message.stderr };
      },
    };
  } catch (error) {
    initialized.resolve();
    if (error instanceof WindowsBotJobSetupError) { windowsJob = error.lease; jobObjectName = windowsJob.name; }
    await close();
    operation.check();
    if (rejectedPreparation !== undefined && error === rejectedPreparation) throw rejectedPreparation.cause;
    throw error;
  }
};
