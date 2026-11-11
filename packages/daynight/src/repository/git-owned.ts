import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import type { Operation } from "../api/operation.js";
import { cleanupMs, diagnostic, gitArgs, gitEnvironment, gitTimeout, maxOutputBytes, RepositoryGitError } from "./git-policy.js";
import type { RepositoryGitOptions, RepositoryGitResult } from "./git-policy.js";

export class RepositoryGitCleanupPendingError extends AggregateError {
  readonly code = "repository_git_cleanup_pending";
  constructor(errors: readonly unknown[], cause: unknown) {
    super(errors, "Repository Git local cleanup is still pending.", { cause });
    this.name = "RepositoryGitCleanupPendingError";
  }
}

export type GitOwnedOutcome =
  | { kind: "success"; result: RepositoryGitResult }
  | { kind: "failure"; error: unknown; settlement: "joined" }
  | { kind: "cleanup-pending"; error: RepositoryGitCleanupPendingError };
export type GitSettlement = { kind: "local-closed"; cleanupErrors: readonly unknown[] };
export type OwnedRepositoryGit = {
  outcome: Promise<GitOwnedOutcome>;
  joined: Promise<GitSettlement>;
  requestStop(): void;
};

/** Owns the original child, its output streams and any started stop helper until their close events. */
export const startOwnedRepositoryGit = (
  cwd: string, args: readonly string[], operation: Operation,
  options: Omit<RepositoryGitOptions, "processGroup"> = {},
): OwnedRepositoryGit => {
  const timeoutMs = gitTimeout(operation, options.timeoutMs);
  let resolveOutcome!: (value: GitOwnedOutcome) => void;
  let resolveJoined!: (value: GitSettlement) => void;
  const outcome = new Promise<GitOwnedOutcome>((resolve) => { resolveOutcome = resolve; });
  const joined = new Promise<GitSettlement>((resolve) => { resolveJoined = resolve; });
  const cleanupErrors: unknown[] = [];
  const failures: unknown[] = [];
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  let stdoutBytes = 0; let stderrBytes = 0;
  let saving = true; let stopRequested = false; let stopDispatched = false; let rootExited = false;
  let outcomeSent = false; let complete = false; let pending = 0; let failedExit = false;
  let exitCode: number | null = null; let exitSignal: NodeJS.Signals | null = null;
  let grace: NodeJS.Timeout | undefined; let commandTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess;

  const recordFailure = (error: unknown): void => {
    if (outcomeSent) cleanupErrors.push(error);
    else failures.push(error);
  };
  const exitFailure = (): RepositoryGitError => new RepositoryGitError(
    "Repository Git command failed", exitCode, exitSignal, diagnostic(Buffer.concat(stderr).toString("utf8")),
  );
  const primary = (): unknown => {
    const errors = failedExit ? [exitFailure(), ...failures] : failures;
    if (errors.length === 0) return undefined;
    if (errors.length === 1) return errors[0];
    return new AggregateError(errors.slice(1), "Repository Git encountered additional errors.", { cause: errors[0] });
  };
  const finish = (): void => {
    if (complete || pending !== 0) return;
    complete = true;
    clearTimeout(commandTimer); clearTimeout(grace);
    operation.signal.removeEventListener("abort", abort);
    try { operation.check(); }
    catch (error) { if (!failures.includes(error) && !cleanupErrors.includes(error)) recordFailure(error); }
    if (outcomeSent && failedExit) cleanupErrors.push(exitFailure());
    const settlement: GitSettlement = { kind: "local-closed", cleanupErrors: cleanupErrors.slice() };
    resolveJoined(settlement);
    if (outcomeSent) return;
    let error = primary();
    const output = diagnostic(Buffer.concat(stderr).toString("utf8"));
    if (error === undefined && (exitCode !== 0 && !(exitCode === 1 && options.allowExitOne))) {
      error = new RepositoryGitError("Repository Git command failed", exitCode, exitSignal, output);
    }
    if (error === undefined && exitCode === null) error = new RepositoryGitError("Repository Git command did not return an exit status", exitCode, exitSignal, output);
    if (cleanupErrors.length) error = new AggregateError(cleanupErrors.slice(), "Repository Git cleanup failed.", error === undefined ? undefined : { cause: error });
    outcomeSent = true;
    if (error !== undefined) resolveOutcome({ kind: "failure", error, settlement: "joined" });
    else resolveOutcome({ kind: "success", result: { stdout: Buffer.concat(stdout).toString("utf8"), stderr: output, exitCode: exitCode! } });
  };
  const watch = (emitter: ChildProcess | Readable): void => {
    pending++;
    emitter.once("close", () => { pending--; finish(); });
  };
  const fallback = (): void => {
    if (rootExited || child.pid === undefined) return;
    try { if (!child.kill("SIGKILL")) cleanupErrors.push(new Error("Could not stop the original Git child.")); }
    catch (error) { cleanupErrors.push(error); }
  };
  const dispatchStop = (): void => {
    if (complete || stopDispatched || rootExited || child.pid === undefined) return;
    stopDispatched = true;
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) cleanupErrors.push(error);
        fallback();
      }
      return;
    }
    try {
      const systemRoot = process.env.SystemRoot;
      if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) throw new Error("SystemRoot must identify an absolute Windows directory to terminate the owned Git process tree.");
      const helper = spawn(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let helperExited = false; let helperFailed = false; let helperBytes = 0; const helperOutput: Buffer[] = [];
      let helperTimer: NodeJS.Timeout | undefined;
      helper.once("close", () => {
        clearTimeout(helperTimer);
        if (helperFailed && helperOutput.length) cleanupErrors.push(new Error(`Repository Git taskkill output: ${diagnostic(Buffer.concat(helperOutput).toString("utf8"))}`));
      });
      watch(helper);
      const helperError = (error: unknown): void => { cleanupErrors.push(error); if (!helperFailed) { helperFailed = true; fallback(); } };
      for (const stream of [helper.stdout, helper.stderr]) {
        if (stream === null) continue;
        watch(stream);
        stream.on("data", (chunk: Buffer) => {
          if (helperBytes + chunk.length <= 64 * 1024) { helperBytes += chunk.length; helperOutput.push(chunk); }
          else if (helperBytes <= 64 * 1024) { helperBytes = 64 * 1024 + 1; helperError(new Error("Repository Git taskkill output exceeded its 65536-byte limit.")); }
        });
        stream.once("error", helperError);
      }
      helper.once("error", helperError);
      helper.once("exit", (code, signal) => {
        helperExited = true;
        if (code !== 0) helperError(new Error(`Repository Git taskkill failed (exit ${String(code)}, signal ${String(signal)}).`));
      });
      helperTimer = setTimeout(() => {
        helperError(new Error("Repository Git taskkill exceeded its cleanup deadline."));
        if (!helperExited) {
          try { if (!helper.kill("SIGKILL")) cleanupErrors.push(new Error("Could not stop the Git taskkill helper.")); }
          catch (error) { cleanupErrors.push(error); }
        }
      }, cleanupMs);
      helperTimer.unref();
    } catch (error) { cleanupErrors.push(error); fallback(); }
  };
  const stop = (): void => {
    if (complete || stopRequested) return;
    stopRequested = true;
    clearTimeout(commandTimer);
    grace = setTimeout(() => {
      if (complete || outcomeSent) return;
      outcomeSent = true;
      resolveOutcome({ kind: "cleanup-pending", error: new RepositoryGitCleanupPendingError(cleanupErrors.slice(), primary()) });
    }, cleanupMs);
    grace.unref();
    dispatchStop();
  };
  const abort = (): void => {
    try { operation.check(); } catch (error) { recordFailure(error); }
    stop();
  };
  try {
    child = spawn("git", gitArgs(args), { cwd, env: gitEnvironment(options.environment), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    recordFailure(new RepositoryGitError("Cannot execute repository Git command", null, null, "", { cause: error }));
    finish();
    return { outcome, joined, requestStop: () => {} };
  }
  // Register every close obligation before a stop or completion can run.
  watch(child);
  for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
    if (stream === null) continue;
    watch(stream);
    stream.on("data", (chunk: Buffer) => {
      if (!saving) return;
      const size = name === "stdout" ? stdoutBytes : stderrBytes;
      if (size + chunk.length > maxOutputBytes) {
        saving = false;
        stop();
        recordFailure(new RepositoryGitError(`Repository Git ${name} exceeded its ${maxOutputBytes}-byte limit`, null, null, diagnostic(Buffer.concat(stderr).toString("utf8"))));
        return;
      }
      if (name === "stdout") { stdoutBytes += chunk.length; stdout.push(chunk); }
      else { stderrBytes += chunk.length; stderr.push(chunk); }
    });
    stream.once("error", (error) => { recordFailure(error); stop(); });
  }
  child.once("exit", (code, signal) => {
    rootExited = true; exitCode = code; exitSignal = signal;
    if ((code !== null || !stopRequested) && code !== 0 && !(code === 1 && options.allowExitOne)) failedExit = true;
  });
  child.once("error", (error) => { recordFailure(new RepositoryGitError("Cannot execute repository Git command", exitCode, exitSignal, diagnostic(Buffer.concat(stderr).toString("utf8")), { cause: error })); });
  child.once("spawn", () => { if (stopRequested) dispatchStop(); });
  operation.signal.addEventListener("abort", abort, { once: true });
  commandTimer = setTimeout(() => {
    let operationError: unknown;
    try { operation.check(); } catch (error) { operationError = error; }
    if (operationError !== undefined && !stopRequested) recordFailure(operationError);
    stop();
    if (operationError === undefined) recordFailure(new RepositoryGitError("Repository Git command deadline exceeded", exitCode, exitSignal, diagnostic(Buffer.concat(stderr).toString("utf8"))));
  }, timeoutMs);
  commandTimer.unref();
  if (operation.signal.aborted) abort();
  return { outcome, joined, requestStop: () => {
    if (complete || stopRequested) return;
    recordFailure(new Error("Repository Git stop requested."));
    stop();
  } };
};
