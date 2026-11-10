import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Operation } from "../api/operation.js";
import { restoreWindowsSpawnError, spawnWindowsOwnedCommand, WindowsCommandCleanupError } from "../platform/windows-owned-command.js";
import { repositoryIdentity } from "./identity.js";

const maxOutputBytes = 1_048_576;
const maxGitMs = 30_000;
const cleanupMs = 1_000;
const repositorySelectors = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_GRAFT_FILE", "GIT_NAMESPACE", "GIT_PREFIX",
  "GIT_SUPER_PREFIX", "GIT_INTERNAL_SUPER_PREFIX", "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_QUARANTINE_PATH",
]);

const gitEnvironment = (overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([name, value]) => {
    const key = name.toUpperCase();
    return value !== undefined && !repositorySelectors.has(key) && !key.startsWith("GIT_TRACE");
  })),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

const diagnostic = (value: string): string => value
  .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[redacted URL]")
  .replace(/[^\s"'<>]+@[^\s"'<>]+:[^\s"'<>]+/g, "[redacted repository address]")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  .slice(0, 8192);

export type RepositoryGitResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export class RepositoryGitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`${message}${exitCode === null ? "" : ` (exit ${exitCode})`}${signal === null ? "" : ` (${signal})`}${stderr === "" ? "" : `: ${stderr}`}`, options);
    this.name = "RepositoryGitError";
  }
}

export type RepositoryGitOptions = {
  readonly allowExitOne?: boolean;
  /** POSIX inherited groups require an outer descendant supervisor; Windows keeps an inner command Job in either mode. */
  readonly processGroup?: "own" | "inherit";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

const runWindowsRepositoryGit = (
  cwd: string,
  args: readonly string[],
  operation: Operation,
  options: RepositoryGitOptions,
  deadline: number,
): Promise<RepositoryGitResult> => new Promise((resolve, reject) => {
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let stdoutBytes = 0, stderrBytes = 0;
  let failure: unknown;
  let failureMessage: string | undefined;
  const cleanupErrors: unknown[] = [];
  let stopping = false, releasing = false, settled = false, committed = false;
  let timer: NodeJS.Timeout | undefined;
  const detach = (): void => {
    clearTimeout(timer);
    operation.signal.removeEventListener("abort", abort);
  };
  const command = spawnWindowsOwnedCommand({
    file: "git", args: ["--no-pager", "-c", "core.fsmonitor=false", ...args], cwd: path.resolve(cwd),
    environment: gitEnvironment(options.environment), stdin: "ignore", resolver: "node", deadline,
    graceMs: cleanupMs, pipeCloseMs: cleanupMs, normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close",
    onReleased: () => { committed = true; detach(); },
  });
  const appendCleanup = (error: unknown): void => {
    if (error instanceof WindowsCommandCleanupError) cleanupErrors.push(...error.errors);
    else cleanupErrors.push(error);
  };
  const complete = (): void => {
    if (settled) return;
    settled = true;
    detach();
    const receipt = command.result;
    const exitCode = receipt?.kind === "exit" ? receipt.code : null;
    const signal = receipt?.kind === "exit" ? receipt.signal : null;
    let operationFailure: unknown;
    if (!committed) {
      try { operation.check(); }
      catch (error) { operationFailure = error; }
    }
    const errorOutput = diagnostic(Buffer.concat(stderr).toString("utf8"));
    const primary = operationFailure ?? (failure !== undefined || failureMessage !== undefined
      ? new RepositoryGitError(failureMessage ?? "Cannot execute repository Git command", exitCode, signal, errorOutput,
        failure === undefined ? undefined : { cause: failure })
      : exitCode !== 0 && !(exitCode === 1 && options.allowExitOne === true)
        ? new RepositoryGitError("Repository Git command failed", exitCode, signal, errorOutput)
        : undefined);
    if (cleanupErrors.length !== 0) {
      reject(new AggregateError(cleanupErrors, "Repository Git process-tree cleanup failed; process termination is unconfirmed.",
        primary === undefined ? undefined : { cause: primary }));
    } else if (primary !== undefined) reject(primary);
    else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: errorOutput, exitCode: exitCode! });
  };
  const stop = (): void => {
    if (stopping || releasing || settled || committed) return;
    stopping = true;
    void command.stop().catch(appendCleanup).finally(complete);
  };
  function abort(): void {
    if (committed || settled) return;
    try { operation.check(); }
    catch (error) { failure = error; }
    stop();
  }
  const expired = (): void => {
    if (committed || settled) return;
    try { operation.check(); }
    catch (error) { failure = error; }
    if (failure === undefined) failureMessage = "Repository Git command deadline exceeded";
    stop();
  };
  const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (failure !== undefined || failureMessage !== undefined) return;
    const size = stream === "stdout" ? stdoutBytes : stderrBytes;
    if (size + chunk.length > maxOutputBytes) {
      failureMessage = `Repository Git ${stream} exceeded its ${maxOutputBytes}-byte limit`;
      stop();
    } else if (stream === "stdout") { stdoutBytes += chunk.length; stdout.push(chunk); }
    else { stderrBytes += chunk.length; stderr.push(chunk); }
  };
  command.stdout.on("data", (chunk: Buffer) => { collect("stdout", chunk); });
  command.stderr.on("data", (chunk: Buffer) => { collect("stderr", chunk); });
  const streamError = (error: Error): void => { failure = error; stop(); };
  command.stdout.once("error", streamError);
  command.stderr.once("error", streamError);
  operation.signal.addEventListener("abort", abort, { once: true });
  timer = setTimeout(expired, Math.max(1, Math.ceil(deadline - performance.now())));
  timer.unref();
  void command.closed.then(async () => {
    if (stopping || settled) return;
    try { operation.check(); }
    catch (error) { failure = error; stop(); return; }
    if (performance.now() >= deadline) { expired(); return; }
    const receipt = command.result;
    if (receipt === undefined) { failure = new Error("The owned Git command closed without a target receipt."); stop(); return; }
    if (receipt.kind === "not-started") failure = restoreWindowsSpawnError(receipt.error);
    else if (receipt.failure !== null) failure = restoreWindowsSpawnError(receipt.failure);
    // RELEASE commits OFF synchronously or finalizes its own failed mutation;
    // a timer must not start a second STOP while that finalization is joining.
    releasing = true;
    try { await command.release(); }
    catch (error) { appendCleanup(error); }
    complete();
  }, (error: unknown) => {
    if (stopping || settled) return;
    failure = error;
    stop();
  });
  if (operation.signal.aborted) abort();
  if (!stopping) void command.start().catch((error: unknown) => {
    if (stopping || settled || committed) return;
    failure = error;
    stop();
  });
});

export const runRepositoryGit = async (
  cwd: string,
  args: readonly string[],
  operation: Operation,
  options: RepositoryGitOptions = {},
): Promise<RepositoryGitResult> => {
  operation.check();
  const commandMs = options.timeoutMs === undefined ? maxGitMs : options.timeoutMs;
  if (!Number.isSafeInteger(commandMs) || commandMs <= 0 || commandMs > 2_147_483_647) throw new RangeError("Git command timeout must be a positive supported integer.");
  const timeoutMs = Math.max(1, Math.ceil(Math.min(commandMs, operation.remainingMs())));
  if (process.platform === "win32") return runWindowsRepositoryGit(cwd, args, operation, options, performance.now() + timeoutMs);
  return new Promise((resolve, reject) => {
    // Index reads do not need an external fsmonitor; its inherited pipes can outlive Git.
    const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
      cwd, env: gitEnvironment(options.environment), windowsHide: true, detached: process.platform !== "win32" && options.processGroup !== "inherit", stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: unknown;
    let failureMessage: string | undefined;
    const cleanupErrors: unknown[] = [];
    let stopped = false;
    let settled = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const complete = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      operation.signal.removeEventListener("abort", abort);
      let operationFailure: unknown;
      try { operation.check(); }
      catch (error) { operationFailure = error; }
      const errorOutput = diagnostic(Buffer.concat(stderr).toString("utf8"));
      const primary = operationFailure ?? (failure !== undefined || failureMessage !== undefined
        ? new RepositoryGitError(failureMessage ?? "Cannot execute repository Git command", exitCode, signal, errorOutput,
          failure === undefined ? undefined : { cause: failure })
        : undefined);
      if (cleanupErrors.length !== 0) {
        reject(new AggregateError(cleanupErrors, "Repository Git process-tree cleanup failed; process termination is unconfirmed.",
          primary === undefined ? undefined : { cause: primary }));
        return;
      }
      if (primary !== undefined) { reject(primary); return; }
      if (exitCode !== 0 && !(exitCode === 1 && options.allowExitOne === true)) {
        reject(new RepositoryGitError("Repository Git command failed", exitCode, signal, errorOutput));
        return;
      }
      if (exitCode === null) {
        reject(new RepositoryGitError("Repository Git command did not return an exit status", exitCode, signal, errorOutput));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: errorOutput, exitCode });
    };
    const stop = (): void => {
      if (stopped || child.pid === undefined) return;
      stopped = true;
      try {
        if (options.processGroup === "inherit") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(process.platform !== "win32" && error instanceof Error && "code" in error && error.code === "ESRCH")) cleanupErrors.push(error);
        child.kill("SIGKILL");
      }
      cleanupTimer = setTimeout(() => {
        cleanupErrors.push(new Error("The owned Git process and inherited output handles did not close within the cleanup deadline."));
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        complete(child.exitCode, child.signalCode);
      }, cleanupMs);
      cleanupTimer.unref();
    };
    const abort = (): void => {
      try { operation.check(); }
      catch (error) { failure = error; }
      stop();
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (failure !== undefined || failureMessage !== undefined) return;
      const size = stream === "stdout" ? stdoutBytes : stderrBytes;
      if (size + chunk.length > maxOutputBytes) {
        failureMessage = `Repository Git ${stream} exceeded its ${maxOutputBytes}-byte limit`;
        stop();
        return;
      }
      if (stream === "stdout") { stdoutBytes += chunk.length; stdout.push(chunk); }
      else { stderrBytes += chunk.length; stderr.push(chunk); }
    };
    child.stdout.on("data", (chunk: Buffer) => { collect("stdout", chunk); });
    child.stderr.on("data", (chunk: Buffer) => { collect("stderr", chunk); });
    const streamError = (error: Error): void => { failure = error; stop(); };
    child.stdout.once("error", streamError);
    child.stderr.once("error", streamError);
    child.once("spawn", () => {
      if (failure !== undefined || failureMessage !== undefined || operation.signal.aborted) stop();
    });
    child.once("error", (error) => { failure = error; });
    operation.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      try { operation.check(); }
      catch (error) { failure = error; }
      if (failure === undefined) failureMessage = "Repository Git command deadline exceeded";
      stop();
    }, timeoutMs);
    timer.unref();
    child.once("close", complete);
    if (operation.signal.aborted) abort();
  });
};

const finalLine = (value: string): string => value.replace(/\r?\n$/, "");

export const discoverWorktreeRoot = async (
  cwd: string,
  operation: Operation,
  options: Pick<RepositoryGitOptions, "processGroup"> = {},
): Promise<string> => {
  let bare: RepositoryGitResult;
  try { bare = await runRepositoryGit(cwd, ["rev-parse", "--is-bare-repository"], operation, options); }
  catch (cause) {
    if (cause === operation.signal.reason) throw cause;
    throw new Error("Cannot locate a Git repository from the current working directory.", { cause });
  }
  if (finalLine(bare.stdout) === "true") throw new Error("This operation requires a Git worktree; the current repository is bare.");
  if (finalLine(bare.stdout) !== "false") throw new Error("Git returned an invalid bare-repository result.");
  const gitRoot = finalLine((await runRepositoryGit(cwd, ["rev-parse", "--show-toplevel"], operation, options)).stdout);
  if (gitRoot === "") throw new Error("Git returned an empty worktree root.");
  if (!path.isAbsolute(gitRoot)) throw new Error("Git returned a worktree root that is not an absolute path.");
  return path.normalize(gitRoot);
};

export const discoverRepository = async (
  cwd: string,
  operation: Operation,
): Promise<{ root: string; remote: string; identity: string }> => {
  const root = await discoverWorktreeRoot(cwd, operation);
  let remote: string;
  try { remote = finalLine((await runRepositoryGit(root, ["remote", "get-url", "origin"], operation)).stdout); }
  catch (cause) {
    if (cause === operation.signal.reason) throw cause;
    throw new Error("Cannot read the current Git repository's origin fetch address.", { cause });
  }
  operation.check();
  const identity = repositoryIdentity(remote);
  operation.check();
  return { root, remote, identity };
};
