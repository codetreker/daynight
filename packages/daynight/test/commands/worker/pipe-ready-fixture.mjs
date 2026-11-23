import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, writeFileSync, writeSync } from "node:fs";

const errors = new Set(["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "EISDIR", "ENOSPC", "EMFILE", "ENFILE"]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT"]);
const errorCode = error => errors.has(error?.code) ? error.code : "unknown";
const signalName = signal => signals.has(signal) ? signal : signal === null ? null : "unknown";

// Every field is constructed here, never from a command, output, path or error message.
const record = (file, stage, fields = {}) => {
  try { appendFileSync(file, `${JSON.stringify({ stage, pid: process.pid, ...fields })}\n`, { mode: 0o600 }); }
  catch { try { writeSync(2, "pipe-ready fixture receipt unavailable\n"); } catch { /* The output may already be closed. */ } }
};

const waitForRelease = release => {
  const poll = setInterval(() => { if (existsSync(release)) { clearInterval(poll); process.exit(0); } }, 20);
  setTimeout(() => process.exit(1), 30_000).unref();
};

const publishReady = (file, receipt, marker) => {
  record(receipt, "ready-attempt", { marker });
  try { writeFileSync(file, "ready"); }
  catch (error) { record(receipt, "ready-error", { marker, code: errorCode(error) }); return false; }
  record(receipt, "ready-success", { marker });
  return true;
};

export const runLeaf = ({ ready, release, receipt }) => {
  record(receipt, "leaf-start");
  if (!publishReady(ready, receipt, "pipe")) { process.exitCode = 1; return; }
  waitForRelease(release);
};

export const runWrapper = ({ stream, ready, rootReady, release, leaf, receipt, gitCommand = "git", gitArgs = process.argv.slice(2) }) => {
  record(receipt, "wrapper-start");
  record(receipt, "git-spawn-attempt", { executable: gitCommand === "git" ? "git" : "controlled", arguments: "redacted" });
  let git;
  try { git = spawn(gitCommand, gitArgs, { stdio: "inherit", windowsHide: true }); }
  catch (error) { record(receipt, "git-error", { code: errorCode(error) }); process.exitCode = 1; return; }
  let started = false, exited = false, failed = false, exitCode = null, exitSignal = null;
  git.once("spawn", () => { started = true; record(receipt, "git-spawn", { childPid: git.pid ?? null }); });
  git.once("error", error => { failed = true; record(receipt, "git-error", { code: errorCode(error) }); });
  git.once("exit", (code, signal) => {
    exited = true; exitCode = code; exitSignal = signal;
    record(receipt, "git-exit", { code, signal: signalName(signal) });
  });
  git.once("close", (code, signal) => {
    record(receipt, "git-close", { started, exited, code, signal: signalName(signal), stdout: "unknown", stderr: "unknown" });
    if (failed || !started || !exited || exitCode !== 0 || exitSignal !== null) { process.exitCode = exitCode || 1; return; }
    if (stream === "child" || stream === "helper") {
      if (!publishReady(stream === "helper" ? rootReady : ready, receipt, stream === "helper" ? "root" : "pipe")) { process.exitCode = 1; return; }
      closeSync(1); closeSync(2);
      waitForRelease(release);
      return;
    }
    record(receipt, "leaf-spawn-attempt");
    let child;
    try { child = spawn(process.execPath, [leaf], { detached: true, stdio: ["ignore", stream === "stdout" ? "inherit" : "ignore", stream === "stderr" ? "inherit" : "ignore"], windowsHide: true }); }
    catch (error) { record(receipt, "leaf-error", { code: errorCode(error) }); process.exitCode = 1; return; }
    child.once("spawn", () => record(receipt, "leaf-spawn", { childPid: child.pid ?? null }));
    child.once("error", error => { record(receipt, "leaf-error", { code: errorCode(error) }); process.exitCode = 1; });
    child.unref();
  });
};
