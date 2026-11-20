import { AsyncLocalStorage } from "node:async_hooks";
import { finished } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Operation } from "../../api/operation.js";
import { captureProcessProof, confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../controller/process-proof.js";
import { createControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../controller/windows-job.js";
import { createSuspendedNodeChild } from "./suspended-node-child.js";
import { withinExecutionDeadline } from "./execution-scope.js";
import { OwnedCommandCleanupError, OwnedCommandError, registerOwnedCommandCleanupConfirmation, type OwnedCommand, type OwnedCommandResult } from "./owned-command.js";

export type OwnedCommandLifecycleEvent = {
  resourceId: string;
  sequence: number;
  stage: "prepared" | "bound" | "stopped" | "unknown";
  proof: ProcessProof | null;
};
/** Commits each event before resolving; rejection must preserve its original reservation. */
export type OwnedCommandLifecycleSink = (event: OwnedCommandLifecycleEvent) => Promise<void>;
/** The sink rejected admission before starting any reservation write. */
export class OwnedCommandAdmissionError extends Error {
  constructor(cause: unknown) { super("Owned command admission was rejected before reservation.", { cause }); }
}
const boundedSave = async (sink: OwnedCommandLifecycleSink, event: OwnedCommandLifecycleEvent, deadline?: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([Promise.resolve().then(() => sink(event)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned command responsibility save exceeded its deadline.")), Math.max(1, Math.min(10_000, deadline === undefined ? 10_000 : deadline - Date.now()))); })]); }
  finally { clearTimeout(timer); }
};
const context = new AsyncLocalStorage<OwnedCommandLifecycleSink>();
type RetainedCommand = {
  proof: ProcessProof | null; lease: ControllerJobLease | undefined; sequence: number;
  neverSpawned: boolean; unstartedClosed: boolean; closure: PromiseWithResolvers<void>; joinSave: () => Promise<void>;
  save: (sink: OwnedCommandLifecycleSink, event: OwnedCommandLifecycleEvent, deadline?: number) => Promise<void>;
  closeHandles?: () => void; joinOutput?: () => Promise<void>;
};
const retained = new Map<string, RetainedCommand>();
const reconciliations = new Map<string, Promise<void>>();
const producers = new Map<string, Promise<void>>();
/** Live responsibility is retained independently of an Error object's reachability. */
export const retainedOwnedCommandBoundaries = (): readonly { resourceId: string; proof: ProcessProof | null }[] => [...retained].map(([resourceId, value]) => ({ resourceId, proof: value.proof }));
export const withOwnedCommandLifecycle = <T>(sink: OwnedCommandLifecycleSink, action: () => T): T => context.run(sink, action);
export const currentOwnedCommandLifecycle = (): OwnedCommandLifecycleSink | undefined => context.getStore();
/** Obtain the original owner's positive close receipt while it still owns the resource. */
export const ownedCommandClosure = (resourceId: string): Promise<void> => {
  const original = retained.get(resourceId);
  if (original === undefined) throw new Error("Original owned command closure is unavailable.");
  return original.closure.promise;
};
const closeRetained = (resourceId: string): void => {
  const original = retained.get(resourceId);
  retained.delete(resourceId);
  original?.closure.resolve();
};

/** Re-observes the retained original boundary; it never repeats the command. */
export const reconcileOwnedCommandBoundary = async (resourceId: string, sink: OwnedCommandLifecycleSink, deadline: number): Promise<void> => {
  const pending = reconciliations.get(resourceId);
  if (pending !== undefined) return withinExecutionDeadline(pending, deadline);
  const work = reconcileBoundary(resourceId, sink, deadline);
  reconciliations.set(resourceId, work);
  const clear = () => { if (reconciliations.get(resourceId) === work) reconciliations.delete(resourceId); };
  void work.then(clear, clear);
  return work;
};
const reconcileBoundary = async (resourceId: string, sink: OwnedCommandLifecycleSink, deadline: number): Promise<void> => {
  const producer = producers.get(resourceId);
  if (producer !== undefined) {
    await withinExecutionDeadline(producer, deadline);
    if (!retained.has(resourceId)) return;
  }
  const original = retained.get(resourceId);
  if (original === undefined) throw new Error("Original owned command boundary evidence is unavailable.");
  // A timed-out observation did not cancel the original filesystem write.
  // No later terminal save may overtake it or discard its live responsibility.
  await withinExecutionDeadline(original.joinSave(), deadline);
  const { proof, lease } = original;
  if (original.neverSpawned || original.unstartedClosed) {
    // Only the original producer can prove that no process was created or
    // that its never-resumed Windows process and native handles were closed.
    // Its first save may have failed before rename, leaving no reservation yet.
    await original.save(sink, { resourceId, sequence: 1, stage: "prepared", proof: null }, deadline);
  } else {
    if (proof === null) throw new Error("Original owned command boundary evidence is unavailable.");
    if (!await confirmControllerProcessesStopped(proof, [], deadline, lease)) await stopControllerProcesses(proof, [], deadline, lease, { guardian: true });
    if (!await confirmControllerProcessesStopped(proof, [], deadline, lease)) throw new Error("Original owned command boundary remains occupied.");
  }
  if (original.joinOutput !== undefined) await withinExecutionDeadline(original.joinOutput(), deadline);
  original.sequence++;
  await original.save(sink, { resourceId, sequence: original.sequence, stage: "stopped", proof }, deadline);
  original.closeHandles?.();
  if (lease !== undefined) releaseControllerJobLease(lease);
  closeRetained(resourceId);
};

/** Uses the same retained process-boundary proofs as Controllers. */
type OwnedCommandOptions = { cleanupWithinDeadline?: boolean; maximumOutputBytes?: number; maximumStreamBytes?: number; timeoutMs?: number; allowExitOne?: boolean; allowAnyExitCode?: boolean; stdin?: string; captureOutput?: boolean; onStdout?: (chunk: Buffer) => Promise<void>; onStderr?: (chunk: Buffer) => Promise<void> };
export const runLifecycleOwnedCommand = (command: OwnedCommand, operation: Operation, sink: OwnedCommandLifecycleSink, options: OwnedCommandOptions = {}): Promise<OwnedCommandResult & { exitCode: number }> => {
  const resourceId = randomUUID();
  const work = runCommand(command, operation, sink, options, resourceId);
  // A rejected producer can still have saved unknown responsibility. Join its
  // actual completion before management or Git re-observes that same resource.
  const joined = work.then(() => undefined, () => undefined);
  producers.set(resourceId, joined);
  void joined.then(() => { if (producers.get(resourceId) === joined) producers.delete(resourceId); });
  return work;
};
const runCommand = async (command: OwnedCommand, operation: Operation, sink: OwnedCommandLifecycleSink, options: OwnedCommandOptions, resourceId: string): Promise<OwnedCommandResult & { exitCode: number }> => {
  operation.check();
  const cleanupDeadline = options.cleanupWithinDeadline === true ? Date.now() + operation.remainingMs() : undefined;
  const budget = (maximum: number): number => Math.max(1, Math.ceil(Math.min(maximum, operation.remainingMs())));
  let sequence = 0;
  let proof: ProcessProof | null = null, lease: ControllerJobLease | undefined;
  let saves = Promise.resolve();
  const save: RetainedCommand["save"] = (target, value, deadline) => {
    const pending = saves.then(() => target(value));
    saves = pending.catch(() => undefined);
    return boundedSave(() => pending, value, deadline);
  };
  let neverSpawned = true, unstartedClosed = false;
  const closure = Promise.withResolvers<void>();
  const cleanupFailure = (errors: unknown[], cause: unknown): OwnedCommandCleanupError => {
    const error = new OwnedCommandCleanupError(errors, cause);
    registerOwnedCommandCleanupConfirmation(error, () => !retained.has(resourceId));
    return error;
  };
  const event = (stage: OwnedCommandLifecycleEvent["stage"]) => {
    sequence++;
    const original = retained.get(resourceId); if (original !== undefined) original.sequence = sequence;
    return save(sink, { resourceId, sequence, stage, proof });
  };
  retained.set(resourceId, { proof, lease, sequence, neverSpawned, unstartedClosed, closure, save, joinSave: () => saves });
  try { await event("prepared"); }
  catch (error) {
    if (error instanceof OwnedCommandAdmissionError) { closeRetained(resourceId); throw error.cause; }
    throw cleanupFailure([error], error);
  }
  try { operation.check(); }
  catch (error) {
    try { await event("stopped"); closeRetained(resourceId); }
    catch (saveError) { throw cleanupFailure([error, saveError], error); }
    throw error;
  }
  const helper = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/commands/worker/owned-command-helper.js" : "./owned-command-helper.js", import.meta.url));
  // Command-specific Node startup hooks must not execute inside the trusted
  // launcher before its boundary has been committed.
  const launcherEnvironment = { ...process.env };
  for (const key of Object.keys(launcherEnvironment)) if (key.toUpperCase() === "NODE_OPTIONS") delete launcherEnvironment[key];
  let suspended: Awaited<ReturnType<typeof createSuspendedNodeChild>> | undefined, resumed = false;
  let child: ReturnType<typeof spawn> | NonNullable<typeof suspended>["child"];
  try {
    neverSpawned = false;
    retained.get(resourceId)!.neverSpawned = false;
    suspended = process.platform === "win32" ? await createSuspendedNodeChild({
    source: `process.argv = [process.execPath, ${JSON.stringify(helper)}, ${JSON.stringify(resourceId)}]; import(${JSON.stringify(pathToFileURL(helper).href)}).catch(() => process.exit(1));`,
    args: [], environment: launcherEnvironment, ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
  }) : undefined;
    child = suspended?.child ?? spawn(process.execPath, [helper, resourceId], { env: launcherEnvironment, ...(command.cwd === undefined ? {} : { cwd: command.cwd }), detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  } catch (error) {
    const errors = [error];
    // A synchronous spawn rejection or a failed CreateProcessW created no
    // process. Other guardian construction failures retain unknown ownership.
    if (process.platform !== "win32" || error instanceof Error && "stage" in error && error.stage === "create") {
      neverSpawned = true;
      retained.get(resourceId)!.neverSpawned = true;
      try { await event("stopped"); closeRetained(resourceId); }
      catch (saveError) { errors.push(saveError); }
      if (errors.length === 1) throw error;
    }
    try { await event("unknown"); } catch (saveError) { errors.push(saveError); }
    const cleanup = new OwnedCommandCleanupError(errors, error);
    registerOwnedCommandCleanupConfirmation(cleanup, () => !retained.has(resourceId));
    throw cleanup;
  }
  let joinOutput: (() => Promise<void>) | undefined;
  const remember = () => retained.set(resourceId, { proof, lease, sequence, neverSpawned, unstartedClosed, closure, save, joinSave: () => saves, ...(joinOutput === undefined ? {} : { joinOutput }), ...(suspended === undefined ? {} : { closeHandles: suspended.closeHandles }) });
  remember();
  let closed = false, dispatchClosed = false, stopped = false, failure: unknown, result: { code: number | null; signal: string | null } | undefined;
  const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  let bytes = 0, stdoutBytes = 0, stderrBytes = 0;
  const accept = (target: Buffer[], chunk: Buffer) => {
    try {
      bytes += chunk.length;
      if (target === chunks.stdout) stdoutBytes += chunk.length; else stderrBytes += chunk.length;
      if (bytes > (options.maximumOutputBytes ?? 64 * 1024) || (options.maximumStreamBytes !== undefined && Math.max(stdoutBytes, stderrBytes) > options.maximumStreamBytes)) throw new RangeError("The owned command exceeded its output limit.");
      operation.consume(chunk.length); if (options.captureOutput !== false) target.push(chunk);
    }
    catch (error) { failure ??= error; }
  };
  const outputJobs = new Set<Promise<void>>();
  const outputStreams: Promise<void>[] = [];
  const consume = (stream: NonNullable<typeof child.stdout>, target: Buffer[], callback?: (chunk: Buffer) => Promise<void>) => {
    outputStreams.push(finished(stream, { readable: true, writable: false, cleanup: true }).catch(error => { failure ??= error; }));
    stream.on("data", (chunk: Buffer) => {
      accept(target, chunk);
      if (callback === undefined || failure !== undefined) return;
      stream.pause();
      const work = Promise.resolve().then(() => callback(chunk)).catch(error => { failure ??= error; }).finally(() => { outputJobs.delete(work); stream.resume(); });
      outputJobs.add(work);
    });
  };
  consume(child.stdout!, chunks.stdout, options.onStdout);
  consume(child.stderr!, chunks.stderr, options.onStderr);
  joinOutput = async () => { await Promise.all(outputStreams); await Promise.all([...outputJobs]); };
  remember();
  let spawned = false, failedSpawn = false;
  child.once("spawn", () => { spawned = true; });
  child.once("error", error => {
    failure ??= error;
    if (process.platform !== "win32" && !spawned && child.pid === undefined) failedSpawn = true;
  });
  child.once("close", () => {
    closed = true;
    // POSIX spawn returns a ChildProcess even when native creation fails. Its
    // own error, absent PID and close prove no process was created; null proof
    // alone does not. Stream writers still have their independent join below.
    if (failedSpawn && !spawned && child.pid === undefined) { neverSpawned = true; remember(); }
  });
  let bound = false;
  const handshake = async (message: unknown): Promise<void> => {
    if (typeof message !== "object" || message === null || !("kind" in message)) throw new Error("Invalid owned launcher message.");
    if (message.kind === "bound") {
      if (bound || !("launchId" in message) || message.launchId !== resourceId || !("proof" in message)) throw new Error("Owned launcher identity conflict.");
      bound = true;
      const observed = message.proof as ProcessProof;
      if (observed.pid !== child.pid) throw new Error("Owned launcher process identity conflict.");
      // Capture independently rather than trusting a serialized proof alone.
      const current = await captureProcessProof(child.pid!, budget(15_000));
      if (current.startedAt !== observed.startedAt || current.commandHash !== observed.commandHash || current.processGroupId !== observed.processGroupId) throw new Error("Owned launcher birth identity conflict.");
      if (suspended === undefined) { proof = current; remember(); await event("bound"); }
      if (proof === null) throw new Error("Owned launcher has no committed process identity.");
      operation.check();
      if (dispatchClosed || failure !== undefined) throw new Error("Owned launcher dispatch was cancelled.");
      if (await inspectProcessProof(proof, budget(5000)) !== "running" || !child.connected) throw new Error("Owned launcher ended before dispatch.");
      // Native observation yields; cancellation and an expired dispatch window
      // must be checked again in the same turn as the irreversible send.
      operation.check();
      if (dispatchClosed || failure !== undefined) throw new Error("Owned launcher dispatch was cancelled.");
      child.send({ kind: "run", file: command.file, args: command.args, environment: command.environment, ...(options.stdin === undefined ? {} : { input: options.stdin }) });
    } else if (message.kind === "result") {
      if (!("code" in message) || !("signal" in message)) throw new Error("Incomplete owned launcher result.");
      const value = message as { code: number | null; signal: string | null };
      if (!bound || !(value.code === null || Number.isInteger(value.code)) || !(value.signal === null || typeof value.signal === "string")) throw new Error("Invalid owned launcher result.");
      result = value;
    } else if (message.kind === "spawn-error") failure ??= Object.assign(new Error("Cannot execute the owned prerequisite command."), "missing" in message && message.missing === true ? { code: "ENOENT" } : {});
    else if (message.kind === "io-error") failure ??= new Error("Owned command input or output capture failed.");
    else throw new Error("Unknown owned launcher message.");
  };
  let messages = Promise.resolve();
  child.on("message", message => { messages = messages.then(() => handshake(message)).catch(error => { failure ??= error; }); });
  if (suspended !== undefined) {
    try {
      proof = { ...await captureProcessProof(child.pid!, budget(15_000)), jobObjectName: `Local\\Daynight-${resourceId}` };
      remember();
      lease = await createControllerJobLease(resourceId, proof, Math.ceil(Date.now() + Math.min(15_000, operation.remainingMs())));
      remember();
      await event("bound");
      operation.check();
      if (failure !== undefined) throw failure;
      resumed = true;
      suspended.resume();
    } catch (error) { failure ??= error; }
  }
  let timeout = Date.now();
  try {
    // The boundary already exists. Cancellation or expiry while binding it must
    // enter native cleanup, including failures from the operation's budget read.
    if (failure === undefined) {
      const available = operation.remainingMs(), reserve = cleanupDeadline === undefined ? 0 : Math.min(available / 2, process.platform === "win32" ? 2500 : 1000);
      timeout += Math.min(options.timeoutMs ?? Math.min(10_000, operation.limits.requestMs), Math.max(1, available - reserve));
    }
  } catch (error) { failure ??= error; }
  try {
    while (!closed && result === undefined && failure === undefined && !operation.signal.aborted && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 10));
    if (operation.signal.aborted) failure ??= operation.signal.reason;
    if (!closed && result === undefined && failure === undefined) failure = new Error("The owned prerequisite command deadline elapsed.");
    dispatchClosed = true;
    // Never release a boundary while the proof commit or dispatch continuation is pending.
    await messages;
    const deadline = cleanupDeadline === undefined ? Date.now() + 10_000 : Math.ceil(cleanupDeadline);
    if (proof !== null && (suspended === undefined || lease !== undefined)) {
      if (!await confirmControllerProcessesStopped(proof, [], deadline, lease)) await stopControllerProcesses(proof, [], deadline, lease, { guardian: true });
      if (!await confirmControllerProcessesStopped(proof, [], deadline, lease)) throw new Error("Owned command boundary remains occupied.");
    } else {
      // Before the handshake no user command was released. Kill only the direct
      // child handle; no PID-based descendant inference is permitted.
      child.kill("SIGKILL");
      if (!closed) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned launcher birth and closure are unconfirmed.")), 1000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!closed) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned command streams did not close.")), 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
    let outputTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([joinOutput(), new Promise<never>((_, reject) => {
        outputTimer = setTimeout(() => reject(new Error("Owned command output consumers did not join.")), Math.max(1, deadline - Date.now()));
      })]);
    } finally { clearTimeout(outputTimer); }
    suspended?.closeHandles();
    if (suspended !== undefined && !resumed) { unstartedClosed = true; remember(); }
    // A runnable POSIX launcher can itself start proof helpers before dispatch.
    // Its direct close cannot establish that those descendants also stopped.
    if (proof === null && !neverSpawned && !unstartedClosed) throw new Error("Owned launcher birth and boundary closure remain unconfirmed.");
    await event("stopped");
    if (lease !== undefined) releaseControllerJobLease(lease);
    stopped = true;
    closeRetained(resourceId);
    if (failure !== undefined) throw failure;
    if (result === undefined) throw new Error("Owned launcher ended without a command result.");
    const stderr = Buffer.concat(chunks.stderr).toString("utf8");
    if ((result.code !== 0 && !(result.code !== null && options.allowAnyExitCode) && !(result.code === 1 && options.allowExitOne)) || result.signal !== null) throw new OwnedCommandError(`Owned prerequisite command failed: exit=${String(result.code)}, signal=${String(result.signal)}.`, result.code, result.signal as NodeJS.Signals | null, stderr);
    operation.check();
    return { stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr, exitCode: result.code! };
  } catch (error) {
    // A stopped event remains final even when the command itself failed.
    if (!stopped) {
      const failures = [error];
      try { await event("unknown"); } catch (cause) { failures.push(cause); }
      const cleanup = new OwnedCommandCleanupError(failures, error);
      registerOwnedCommandCleanupConfirmation(cleanup, () => !retained.has(resourceId));
      throw cleanup;
    }
    throw error;
  }
};
