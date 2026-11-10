import { spawn } from "node:child_process";
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import koffi from "koffi";

const [directory, role = "root"] = process.argv.slice(2);
const script = fileURLToPath(import.meta.url);
const codes = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT", "EIO", "ENOSPC", "EMFILE", "ENFILE", "EINVAL", "UNKNOWN"]);
const syscalls = new Set(["open", "write", "close", "rename", "stat", "read", "spawn"]);
const heartbeatByte = Buffer.from([1]);
let stage = "identity", failed = false, timer;
const publish = (filename, value) => {
  writeFileSync(filename + ".tmp", JSON.stringify(value));
  renameSync(filename + ".tmp", filename);
};
const errorFields = error => {
  const fields = { name: error instanceof Error ? error.name : "NonErrorThrown" };
  if (error instanceof Error && codes.has(error.code)) fields.code = error.code;
  if (error instanceof Error && syscalls.has(error.syscall)) fields.syscall = error.syscall;
  return fields;
};
const report = (error, failedStage = stage) => {
  if (failed) process.exit(1);
  failed = true; clearInterval(timer);
  const receipt = { schemaVersion: 1, role, stage: failedStage, ...errorFields(error) };
  try { publish(path.join(directory, role + ".error.json"), receipt); }
  catch (publicationError) { process.stderr.write(JSON.stringify({ kind: "native-actor-receipt-failed", receipt, publicationError: errorFields(publicationError) }) + "\n"); }
  process.exit(1);
};
process.once("uncaughtException", error => { report(error); });
process.once("unhandledRejection", error => { report(error); });

const kernel = koffi.load("kernel32.dll");
const current = kernel.func("void * __stdcall GetCurrentProcess()");
const times = kernel.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
const creation = Buffer.alloc(8);
if (!times(current(), creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw new Error("Fixture self identity is unavailable.");
stage = "identity-publish";
publish(path.join(directory, role + ".json"), { pid: process.pid, parentPid: process.ppid, birth: creation.readBigUInt64LE().toString() });
let spawned = false, attempted = false;
timer = setInterval(() => {
  stage = "poll";
  if (existsSync(path.join(directory, `leave-${role}`))) process.exit(0);
  if (role === "root" && !spawned && existsSync(path.join(directory, "spawn"))) {
    stage = "spawn-middle"; spawned = true;
    const child = spawn(process.execPath, [script, directory, "middle"], { stdio: "ignore", windowsHide: true });
    child.once("error", error => { report(error, "spawn-middle"); });
  }
  if (role === "middle" && !spawned) {
    stage = "spawn-leaf"; spawned = true;
    const child = spawn(process.execPath, [script, directory, "leaf"], { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", error => { report(error, "spawn-leaf"); });
  }
  if (role === "leaf" || role === "bystander") {
    stage = "heartbeat-append";
    appendFileSync(path.join(directory, role + ".heartbeat"), heartbeatByte);
  }
  if (role === "root" && !attempted && existsSync(path.join(directory, "attempt-fork"))) {
    stage = "attempt-fork"; attempted = true;
    const marker = path.join(directory, "forbidden-child");
    let failure = null;
    try {
      const child = spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], { stdio: "ignore", windowsHide: true });
      child.once("error", error => { failure = { code: error.code, message: error.message }; });
      child.once("close", (code, signal) => { stage = "fork-result"; publish(path.join(directory, "fork-result.json"), { code, signal, failure, marker: existsSync(marker) }); });
    } catch (error) {
      stage = "fork-result";
      publish(path.join(directory, "fork-result.json"), { failure: { code: error.code, message: error.message }, marker: existsSync(marker) });
    }
  }
}, 5);
