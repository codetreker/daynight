import { execFileSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import crossSpawn from "cross-spawn";
import type { Operation } from "../../api/operation.js";

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
  constructor() { super("The Owned prerequisite command deadline elapsed."); this.name = "OwnedCommandDeadlineError"; }
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

export const hasOwnedCommandCleanupFailure = (error: unknown): boolean => error instanceof Error && (
  error instanceof OwnedCommandCleanupError || hasOwnedCommandCleanupFailure(error.cause) ||
  (error instanceof AggregateError && error.errors.some(hasOwnedCommandCleanupFailure))
);

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
      if (!closed) cleanupErrors.push(new Error("The owned prerequisite process and output streams did not close after termination."));
    }
    if (cleanupErrors.length !== 0) {
      const error = new OwnedCommandCleanupError(cleanupErrors, failure);
      // The existing close listener outlives this bounded wait; exit alone is insufficient.
      if (!terminationFailed) cleanupConfirmations.set(error, () => closed);
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
