import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

// Process snapshots and wrapper metadata exclude argv and environment.
// Unified-log evidence retains filtered native messages, including their context.
const errorDetails = error => ({ name: error?.name ?? "Error", code: error?.code ?? null });
const outputLimit = 1024 * 1024;

/** Each subprocess here is an observer owned by this invocation, never a test process. */
export const runProbe = (file, args, { timeoutMs, signal }) => new Promise(resolve => {
  if (signal?.aborted) { resolve({ pid: null, code: null, signal: null, stdout: "", stderr: "", error: { name: "AbortError", code: "ABORT_ERR" } }); return; }
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let error = null, timedOut = false, truncated = false, settled = false, requestedSignal = null;
  const stdout = [], stderr = []; let stdoutBytes = 0, stderrBytes = 0;
  const collect = (chunks, bytes, chunk) => {
    const available = Math.max(0, outputLimit - bytes);
    if (chunk.length > available) truncated = true;
    if (available > 0) chunks.push(chunk.subarray(0, available));
    return bytes + chunk.length;
  };
  child.stdout.on("data", chunk => { stdoutBytes = collect(stdout, stdoutBytes, chunk); });
  child.stderr.on("data", chunk => { stderrBytes = collect(stderr, stderrBytes, chunk); });
  const finish = (code, stoppedBy, completionConfirmed) => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
    resolve({ pid: child.pid ?? null, code, signal: stoppedBy, completionConfirmed, requestedSignal, timedOut, truncated, error, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  };
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) { requestedSignal = "SIGKILL"; child.kill(requestedSignal); }
    // A descendant can inherit the observer's pipes after its direct parent
    // exits. Close only these observer handles; never signal a process group.
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    finish(child.exitCode, child.signalCode, false);
  };
  const cancel = () => { error = { name: "AbortError", code: "ABORT_ERR" }; stop(); };
  const timer = setTimeout(() => { timedOut = true; error = { name: "TimeoutError", code: "ETIMEDOUT" }; stop(); }, timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  child.on("error", failure => { error = errorDetails(failure); });
  child.on("close", (code, stoppedBy) => finish(code, stoppedBy, true));
});

const wait = (milliseconds, signal) => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, milliseconds);
  signal.addEventListener("abort", done, { once: true });
});

const logPredicate = '(process == "kernel" OR process == "runningboardd" OR process == "launchd") AND (eventMessage CONTAINS[c] "kill" OR eventMessage CONTAINS[c] "terminat" OR eventMessage CONTAINS[c] "memory pressure" OR eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "jetsam")';

/** Observe an unchanged command. Probe failure never replaces the command's exit result. */
export async function observeValidation({ output, command, platform = process.platform, probe = runProbe, processIntervalMs = 5000, memoryIntervalMs = 15000 }) {
  if (!command?.length || command.some(value => typeof value !== "string") || !output) throw new Error("An output directory and command are required.");
  let observerErrors = 0, outputAvailable = true;
  const failedWrite = error => {
    observerErrors++;
    if (outputAvailable) process.stderr.write(`Native validation evidence unavailable: ${JSON.stringify(errorDetails(error))}\n`);
    outputAvailable = false;
  };
  try { mkdirSync(output, { recursive: true }); } catch (error) { failedWrite(error); }
  const record = value => {
    if (!outputAvailable) return;
    try { appendFileSync(path.join(output, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`); }
    catch (error) { failedWrite(error); }
  };
  const startedAt = new Date().toISOString(), startSeconds = Math.floor(Date.now() / 1000);
  record({ kind: "observer-start", wrapperPid: process.pid, platform, processIntervalMs, memoryIntervalMs, probeTimeoutMs: 2000, logTimeoutMs: 10000 });
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", shell: false });
  let spawnError = null;
  const completion = new Promise(resolve => {
    child.on("error", error => { spawnError = errorDetails(error); });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  record({ kind: "child-start", pid: child.pid ?? null, wrapperPid: process.pid });
  const controller = new AbortController();
  const capture = async (kind, file, args, timeoutMs, signal) => {
    record({ kind: "probe-start", probe: kind });
    try {
      const result = await probe(file, args, { timeoutMs, signal });
      if ((result.error || result.code !== 0) && result.error?.code !== "ABORT_ERR") observerErrors++;
      record({ kind: "probe-result", probe: kind, ...result });
    } catch (error) { observerErrors++; record({ kind: "observer-error", probe: kind, error: errorDetails(error) }); }
  };
  const sampler = (async () => {
    if (platform !== "darwin") return;
    let nextMemory = 0;
    try {
      while (!controller.signal.aborted) {
        const tick = performance.now();
        await capture("processes", "/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss=,etime="], 2000, controller.signal);
        if (!controller.signal.aborted && tick >= nextMemory) {
          nextMemory = tick + memoryIntervalMs;
          await capture("vm-stat", "/usr/bin/vm_stat", [], 2000, controller.signal);
          if (!controller.signal.aborted) await capture("swap", "/usr/sbin/sysctl", ["-n", "vm.swapusage"], 2000, controller.signal);
        }
        await wait(Math.max(0, processIntervalMs - (performance.now() - tick)), controller.signal);
      }
    } finally { record({ kind: "observer-stopped" }); }
  })();
  let outcome, endedAt, endSeconds;
  try {
    outcome = await completion;
    endedAt = new Date().toISOString(); endSeconds = Math.ceil(Date.now() / 1000);
    record({ kind: "child-exit", pid: child.pid ?? null, ...outcome, error: spawnError });
  } finally {
    // Cancel only the observation loop and its current native probe.
    controller.abort(); await sampler;
  }
  if (platform === "darwin" && child.pid !== undefined) {
    await capture("unified-log", "/usr/bin/log", ["show", "--style", "ndjson", "--timezone", "UTC", "--start", `@${startSeconds}`, "--end", `@${endSeconds}`, "--predicate", logPredicate], 10000, new AbortController().signal);
  }
  const exitCode = spawnError ? spawnError.code === "ENOENT" ? 127 : 1 : outcome.code ?? (outcome.signal ? 128 + (constants.signals[outcome.signal] ?? 1) : 1);
  const result = { startedAt, endedAt, wrapperPid: process.pid, pid: child.pid ?? null, ...outcome, exitCode, spawnError, observerErrors };
  record({ kind: "observer-complete", exitCode, observerErrors });
  if (outputAvailable) {
    try { writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`); }
    catch (error) { failedWrite(error); }
  }
  result.observerErrors = observerErrors;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] !== "--output" || !args[1] || args[2] !== "--" || !args[3]) {
    process.stderr.write("Usage: node observe-native-validation.mjs --output <directory> -- <command> [arguments...]\n");
    process.exitCode = 2;
  } else {
    try { process.exitCode = (await observeValidation({ output: args[1], command: args.slice(3) })).exitCode; }
    catch (error) { process.stderr.write(`Native validation wrapper failed: ${JSON.stringify(errorDetails(error))}\n`); process.exitCode = 1; }
  }
}
