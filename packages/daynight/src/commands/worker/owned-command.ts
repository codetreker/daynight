import { execFileSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import crossSpawn from "cross-spawn";
import { OperationError, type Operation } from "../../api/operation.js";
import { currentOwnedCommandLifecycle, runLifecycleOwnedCommand } from "./owned-command-lifecycle.js";
import { ControllerProcessWaitDeadlineError, isControllerProcessObservationDeadline } from "../controller/process-proof.js";

export type OwnedSpawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export const spawnOwnedProcess: OwnedSpawn = (file, args, options) => crossSpawn(file, [...args], options);
export type OwnedCommand = { file: string; args: readonly string[]; environment: NodeJS.ProcessEnv; cwd?: string };
export type OwnedCommandResult = { stdout: string; stderr: string };

export class OwnedCommandError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly signal: NodeJS.Signals | null, readonly stderr: string, options?: ErrorOptions) {
    super(message, options); this.name = "OwnedCommandError";
  }
}

export class OwnedCommandDeadlineError extends Error {
  constructor(message = "The Owned prerequisite command deadline elapsed.") { super(message); this.name = "OwnedCommandDeadlineError"; }
}

export class OwnedCommandCleanupError extends AggregateError {
  constructor(errors: readonly unknown[], cause: unknown) {
    super(errors, "Owned prerequisite command cleanup remained unconfirmed.", cause === undefined ? undefined : { cause });
    this.name = "OwnedCommandCleanupError";
  }
}

// Only the original runner can acknowledge its child and output streams. Legacy
// cleanup errors, including other cleanup owners, have no such acknowledgement.
const cleanupConfirmations = new WeakMap<OwnedCommandCleanupError, () => boolean>();
/** Register only the original owner's close proof; exit or a PID lookup is insufficient. */
export const registerOwnedCommandCleanupConfirmation = (error: OwnedCommandCleanupError, confirmed: () => boolean): void => { cleanupConfirmations.set(error, confirmed); };

// Preserve the original cleanup, wait and command-failure graph. Object identity
// alone does not prevent an admitted failure from later acquiring another error.
const snapshotCleanupEvidence = (root: Error): (() => boolean) => {
  const snapshots = new Map<object, { prototype: object | null; descriptors: PropertyDescriptorMap }>();
  const visit = (value: unknown): void => {
    if (!(value instanceof Error) && !Array.isArray(value) || snapshots.has(value)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value) as PropertyDescriptorMap;
    snapshots.set(value, { prototype: Object.getPrototypeOf(value), descriptors });
    for (const descriptor of Object.values(descriptors)) if ("value" in descriptor) visit(descriptor.value);
  };
  visit(root);
  return () => [...snapshots].every(([object, snapshot]) => {
    if (Object.getPrototypeOf(object) !== snapshot.prototype) return false;
    const current = Object.getOwnPropertyDescriptors(object), keys = Reflect.ownKeys(snapshot.descriptors);
    return keys.length === Reflect.ownKeys(current).length && keys.every(key => {
      const before = Reflect.get(snapshot.descriptors, key) as PropertyDescriptor;
      const after = Reflect.get(current, key) as PropertyDescriptor | undefined;
      return after !== undefined && before.configurable === after.configurable && before.enumerable === after.enumerable &&
        before.writable === after.writable && before.value === after.value && before.get === after.get && before.set === after.set;
    });
  });
};
const cleanupWaits = new WeakSet<Error>();
const cleanupWaitEvidence = new WeakMap<OwnedCommandCleanupError, { wait: Error; observation: boolean; intact: () => boolean; commandDeadline?: OwnedCommandDeadlineError; cancellation?: OperationError; cancellationCause: unknown; originalCause: unknown; originalErrors: readonly unknown[] }>();
/** A deadline created by the original owner while waiting for cleanup. */
export const ownedCommandCleanupWait = (message: string): Error => {
  const error = new Error(message);
  cleanupWaits.add(error);
  return error;
};
/** Associate the owner's wait and optional command deadline with its original error. */
export const registerOwnedCommandCleanupWait = (error: OwnedCommandCleanupError, wait: unknown, commandFailure: unknown, signal?: AbortSignal): void => {
  if (!(wait instanceof Error)) return;
  const observation = isControllerProcessObservationDeadline(wait);
  if (!(cleanupWaits.has(wait) || wait instanceof ControllerProcessWaitDeadlineError || observation)) return;
  const commandDeadline = commandFailure instanceof OwnedCommandDeadlineError ? commandFailure : undefined;
  const cancellation = signal?.aborted === true && commandFailure === signal.reason && commandFailure instanceof OperationError && commandFailure.kind === "cancelled" ? commandFailure : undefined;
  const allowed = (item: unknown): boolean => item === wait || commandDeadline !== undefined && item === commandDeadline || cancellation !== undefined && item === cancellation;
  if (!error.errors.includes(wait) || !error.errors.every(allowed) || error.cause !== undefined && !allowed(error.cause)) return;
  cleanupWaitEvidence.set(error, { wait, observation, intact: snapshotCleanupEvidence(error), ...(commandDeadline === undefined ? {} : { commandDeadline }), ...(cancellation === undefined ? {} : { cancellation }), cancellationCause: cancellation?.cause, originalCause: error.cause, originalErrors: [...error.errors] });
};

/** The optional predicate must recognize cancellation of the caller's own reporter. */
export const isConfirmedOwnedCommandCleanupWait = (error: unknown, isCancellation?: (error: unknown) => boolean): boolean => {
  if (!(error instanceof OwnedCommandCleanupError) || cleanupConfirmations.get(error)?.() !== true) return false;
  const evidence = cleanupWaitEvidence.get(error);
  if (evidence === undefined || !evidence.intact() || evidence.commandDeadline?.cause !== undefined) return false;
  if (evidence.observation) {
    if (!isControllerProcessObservationDeadline(evidence.wait)) return false;
  } else if (!(cleanupWaits.has(evidence.wait) || evidence.wait instanceof ControllerProcessWaitDeadlineError) || evidence.wait.cause !== undefined) return false;
  if (evidence.cancellation !== undefined) {
    if (evidence.cancellation.cause !== evidence.cancellationCause) return false;
    try { if (isCancellation?.(evidence.cancellation) !== true) return false; } catch { return false; }
  }
  const allowed = (item: unknown): boolean => item === evidence.wait || item === evidence.commandDeadline && item !== undefined || item === evidence.cancellation && item !== undefined;
  return error.cause === evidence.originalCause && error.errors.length === evidence.originalErrors.length &&
    evidence.originalErrors.every((item, index) => error.errors[index] === item) && error.errors.every(allowed);
};

export const hasOwnedCommandCleanupFailure = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  return error instanceof OwnedCommandCleanupError || hasOwnedCommandCleanupFailure(error.cause, seen) ||
    (error instanceof AggregateError && error.errors.some((item: unknown) => hasOwnedCommandCleanupFailure(item, seen)));
};

/** Current cleanup responsibility, independent of the historical failure category. */
export const hasUnconfirmedOwnedCommandCleanup = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  return (error instanceof OwnedCommandCleanupError && cleanupConfirmations.get(error)?.() !== true) ||
    hasUnconfirmedOwnedCommandCleanup(error.cause, seen) ||
    (error instanceof AggregateError && error.errors.some((item: unknown) => hasUnconfirmedOwnedCommandCleanup(item, seen)));
};

export const terminateOwnedProcess = (child: ChildProcess, timeoutMs = 2_000): void => {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) throw new Error("SystemRoot must identify an absolute Windows directory to stop the owned process tree.");
    execFileSync(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: Math.max(1, Math.ceil(timeoutMs)), stdio: "pipe", maxBuffer: 64 * 1024 });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
};

export const runOwnedCommand = async (
  command: OwnedCommand,
  operation: Operation,
  start: OwnedSpawn = spawnOwnedProcess,
  options: { cleanupWithinDeadline?: boolean } = {},
): Promise<OwnedCommandResult> => {
  operation.check();
  if (command.cwd !== undefined && (!path.isAbsolute(command.cwd) || /[\0\r\n]/.test(command.cwd))) throw new TypeError("A Owned prerequisite command working directory must be absolute and contain no control separators.");
  const lifecycle = currentOwnedCommandLifecycle();
  if (lifecycle !== undefined && start === spawnOwnedProcess) {
    const { stdout, stderr } = await runLifecycleOwnedCommand(command, operation, lifecycle, options);
    return { stdout, stderr };
  }
  const available = operation.remainingMs();
  const cleanupDeadline = options.cleanupWithinDeadline === true ? performance.now() + available : null;
  // Short metadata probes reserve time to terminate and join inside their caller's total budget.
  const reserve = cleanupDeadline === null ? 0 : Math.min(available / 2, process.platform === "win32" ? 2_500 : 1_000);
  const timeout = Math.max(1, Math.floor(Math.min(10_000, available - reserve, operation.limits.requestMs)));
  const child = start(command.file, command.args, { env: command.environment, ...(command.cwd === undefined ? {} : { cwd: command.cwd }), detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | null = null;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let terminating = false;
  let terminationFailed = false;
  const terminate = (): void => {
    if (closed || terminating) return;
    terminating = true;
    try { terminateOwnedProcess(child, cleanupDeadline === null ? 2_000 : Math.max(1, cleanupDeadline - performance.now())); } catch (error) { terminationFailed = true; cleanupErrors.push(error); }
  };
  const interrupt = (reason: unknown): void => { if (failure === undefined) failure = reason; terminate(); };
  const accept = (parts: Buffer[], chunk: Buffer): void => {
    if (failure !== undefined) return;
    try {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new RangeError("The Owned prerequisite command exceeded its 64 KiB output limit.");
      operation.consume(chunk.length);
      parts.push(chunk);
    } catch (error) { interrupt(error); }
  };
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (code, signal) => { closed = true; exitCode = code; exitSignal = signal; });
  child.stdout?.on("data", (chunk: Buffer) => accept(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => accept(stderr, chunk));
  const abort = (): void => interrupt(operation.signal.reason);
  const timer = setTimeout(() => interrupt(new OwnedCommandDeadlineError()), timeout);
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  try {
    while (!closed && failure === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (!closed) {
      const deadline = cleanupDeadline === null ? performance.now() + 2_000 : cleanupDeadline;
      while (!closed && performance.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (!closed) cleanupErrors.push(ownedCommandCleanupWait("The owned prerequisite process and output streams did not close after termination."));
    }
    if (cleanupErrors.length !== 0) {
      const error = new OwnedCommandCleanupError(cleanupErrors, failure);
      // The existing close listener outlives this bounded wait; exit alone is insufficient.
      if (!terminationFailed) cleanupConfirmations.set(error, () => closed);
      registerOwnedCommandCleanupWait(error, cleanupErrors.at(-1), failure, operation.signal);
      throw error;
    }
    if (failure !== undefined) throw failure;
    if (spawnError !== null) throw new OwnedCommandError("Cannot execute the Owned prerequisite command.", exitCode, exitSignal, "", { cause: spawnError });
    const errorOutput = Buffer.concat(stderr).toString("utf8");
    if (exitCode !== 0 || exitSignal !== null) throw new OwnedCommandError(`Owned prerequisite command failed: exit=${String(exitCode)}, signal=${String(exitSignal)}.`, exitCode, exitSignal, errorOutput);
    operation.check();
    return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: errorOutput };
  } finally {
    clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
  }
};
